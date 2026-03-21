// viewer.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import {
  Viewer,
  Ion,
  WebMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  ArcGisMapServerImageryProvider,
  WebMercatorTilingScheme,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  Cartesian3,
  Rectangle,
  Credit,
  Color,
  Material,
} from "cesium";
import { appConfig } from "./config.js";

export let viewer;
const activeOverlays = new Map();
let currentBaseLayer = null;
let isDarkMode = false;
let isTerrainActive = false;
let contoursEnabled = false;
let contourSpacing = 100.0;

async function createImageryProvider(layer) {
  let rect = Rectangle.MAX_VALUE;
  if (layer.rectangle && layer.rectangle.length === 4) {
    rect = Rectangle.fromDegrees(...layer.rectangle);
  }

  const manualCredit = layer.attribution
    ? new Credit(layer.attribution, false)
    : undefined;

  switch (layer.type) {
    case "wms":
      return new WebMapServiceImageryProvider({
        url: layer.url,
        layers: layer.layers,
        rectangle: rect,
        tilingScheme: new WebMercatorTilingScheme(),
        enablePickFeatures: false,
        credit: manualCredit,
        parameters: { transparent: "true", format: "image/png" },
      });
    case "xyz":
    case "tms":
      return new UrlTemplateImageryProvider({
        url: layer.url,
        rectangle: rect,
        credit: manualCredit,
        subdomains: layer.subdomains || ["a", "b", "c"],
      });
    case "arcgis": {
      const provider = await ArcGisMapServerImageryProvider.fromUrl(layer.url, {
        enablePickFeatures: false,
      });
      // Override the server-provided credit if a manual one is available
      if (manualCredit) {
        Object.defineProperty(provider, "credit", {
          get: () => manualCredit,
        });
      }
      return provider;
    }
    default:
      // Fallback to OSM
      return new UrlTemplateImageryProvider({
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        subdomains: ["a", "b", "c"],
        credit: new Credit(
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
          false,
        ),
      });
  }
}

export async function setBaseLayer(layerConfig) {
  const provider = await createImageryProvider(layerConfig);

  if (currentBaseLayer) {
    viewer.imageryLayers.remove(currentBaseLayer);
  }

  // Base layer is always at the bottom (index 0)
  currentBaseLayer = viewer.imageryLayers.addImageryProvider(provider, 0);

  // Dark mode aesthetic: Hide atmosphere if layer name contains 'dark' or 'night'
  const layerName = (layerConfig.name || "").toLowerCase();
  isDarkMode = layerName.includes("dark") || layerName.includes("night");
  if (isDarkMode) {
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.backgroundColor = Color.BLACK;
  } else {
    viewer.scene.skyAtmosphere.show = true;
    // If we lose dark mode, we must lose contours too
    if (contoursEnabled) {
      setElevationContours(false);
    }
  }
  checkAnalysisAvailability();
}

export async function setTerrain(isTerrain) {
  try {
    if (isTerrain && appConfig.terrain_url) {
      console.log("Setting terrain provider to:", appConfig.terrain_url);
      const provider = await CesiumTerrainProvider.fromUrl(
        appConfig.terrain_url,
      );
      viewer.terrainProvider = provider;
      isTerrainActive = true;
    } else {
      console.log("Setting terrain provider to Ellipsoid");
      viewer.terrainProvider = new EllipsoidTerrainProvider();
      isTerrainActive = false;
      // If we lose terrain, we must lose contours too
      if (contoursEnabled) {
        setElevationContours(false);
      }
    }
  } catch (e) {
    console.error("Failed to set terrain provider:", e);
    // Fallback to Ellipsoid on error
    viewer.terrainProvider = new EllipsoidTerrainProvider();
    isTerrainActive = false;
    if (contoursEnabled) {
      setElevationContours(false);
    }
  }
  checkAnalysisAvailability();
}

export function setElevationContours(active) {
  const oldState = contoursEnabled;
  if (active && isTerrainActive && isDarkMode) {
    viewer.scene.globe.material = Material.fromType("ElevationContour", {
      color: Color.CYAN,
      width: 1.0,
      spacing: contourSpacing,
    });
    contoursEnabled = true;
  } else {
    viewer.scene.globe.material = undefined;
    contoursEnabled = false;
  }

  if (contoursEnabled !== oldState) {
    window.dispatchEvent(
      new CustomEvent("contoursChanged", { detail: { active: contoursEnabled } }),
    );
  }
  return contoursEnabled;
}

export function setContourSpacing(val) {
  contourSpacing = val;
  if (contoursEnabled && viewer.scene.globe.material) {
    viewer.scene.globe.material.uniforms.spacing = val;
  }
}

function checkAnalysisAvailability() {
  const section = document.getElementById("analysisSection");
  if (!section) return;

  const available = isTerrainActive && isDarkMode;
  if (available) {
    section.classList.remove("hidden");
  } else {
    section.classList.add("hidden");
  }
}

export async function toggleOverlayLayer(layerConfig, active) {
  if (active) {
    if (!activeOverlays.has(layerConfig.name)) {
      const provider = await createImageryProvider(layerConfig);
      const cesiumLayer = viewer.imageryLayers.addImageryProvider(provider);
      activeOverlays.set(layerConfig.name, cesiumLayer);
    }
  } else {
    const cesiumLayer = activeOverlays.get(layerConfig.name);
    if (cesiumLayer) {
      viewer.imageryLayers.remove(cesiumLayer);
      activeOverlays.delete(layerConfig.name);
    }
  }
}

export function clearOverlayLayers() {
  activeOverlays.forEach((cesiumLayer) => {
    viewer.imageryLayers.remove(cesiumLayer);
  });
  activeOverlays.clear();
}

export async function initViewer() {
  console.log("Initializing Viewer. Current appConfig:", appConfig);

  const ionToken = appConfig.cesium_ion_token;
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  // Use a simple initial imagery provider to avoid startup failure
  const initialImagery = new UrlTemplateImageryProvider({
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    credit: new Credit(
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      false,
    ),
  });

  viewer = new Viewer("cesiumContainer", {
    terrainProvider: new EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    imageryProvider: initialImagery,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    infoBox: true,
    selectionIndicator: true,
    navigationHelpButton: false,
    sceneModePicker: true,
    terrainExaggeration: appConfig.terrain_exaggeration || 1.0,
    terrainExaggerationRelativeHeight: 0.0,
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.camera.percentageChanged = 0.01;
  currentBaseLayer = viewer.imageryLayers.get(0);

  let initialDestination = Cartesian3.fromDegrees(
    appConfig.initial_lon || 24.9384,
    appConfig.initial_lat || 60.1699,
    1000000.0,
  );

  if (appConfig.imagery_layers && appConfig.imagery_layers.length > 0) {
    const firstLayer = appConfig.imagery_layers[0];
    if (firstLayer.rectangle && firstLayer.rectangle.length === 4) {
      const rect = Rectangle.fromDegrees(...firstLayer.rectangle);
      const center = Rectangle.center(rect);
      initialDestination = Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        1000000.0,
      );
    }
  }

  viewer.camera.setView({
    destination: initialDestination,
  });

  return viewer;
}
