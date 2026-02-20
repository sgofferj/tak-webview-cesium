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
} from "cesium";
import { appConfig, i18n } from "./config.js";

export let viewer;
const activeOverlays = new Map();
let currentBaseLayer = null;

async function createImageryProvider(layer) {
  let rect = Rectangle.MAX_VALUE;
  if (layer.rectangle && layer.rectangle.length === 4) {
    rect = Rectangle.fromDegrees(...layer.rectangle);
  }

  const credit = layer.attribution ? new Credit(layer.attribution) : undefined;

  switch (layer.type) {
    case "wms":
      return new WebMapServiceImageryProvider({
        url: layer.url,
        layers: layer.layers,
        rectangle: rect,
        tilingScheme: new WebMercatorTilingScheme(),
        enablePickFeatures: false,
        credit: credit,
        parameters: { transparent: "true", format: "image/png" },
      });
    case "xyz":
    case "tms":
      return new UrlTemplateImageryProvider({
        url: layer.url,
        rectangle: rect,
        credit: credit,
        subdomains: layer.subdomains || ["a", "b", "c"],
      });
    case "arcgis":
      return await ArcGisMapServerImageryProvider.fromUrl(layer.url, {
        enablePickFeatures: false,
        credit: credit,
      });
    default:
      // Fallback to OSM
      return new UrlTemplateImageryProvider({
        url: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        credit: "© OpenStreetMap contributors",
      });
  }
}

export async function setBaseLayer(layerConfig) {
  const provider = await createImageryProvider(layerConfig);
  if (currentBaseLayer) {
    viewer.imageryLayers.remove(currentBaseLayer);
  }
  // Base layer is always the bottom-most layer (index 0)
  currentBaseLayer = viewer.imageryLayers.addImageryProvider(provider, 0);
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
    url: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
    credit: "© OpenStreetMap contributors",
  });

  const terrainViewModels = [];
  if (appConfig.terrain_url) {
    terrainViewModels.push({
      name: i18n.ellipsoidLabel || "WGS84 Ellipsoid",
      creationFunction: () => new EllipsoidTerrainProvider(),
    });
    terrainViewModels.push({
      name: i18n.terrainLabel || "Terrain",
      creationFunction: () =>
        CesiumTerrainProvider.fromUrl(appConfig.terrain_url),
    });
  }

  viewer = new Viewer("cesiumContainer", {
    terrainProvider: undefined,
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
