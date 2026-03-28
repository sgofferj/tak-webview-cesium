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
  GeoJsonDataSource,
  KmlDataSource,
  CzmlDataSource,
  HeightReference,
  ClassificationType,
  JulianDate,
  CallbackProperty, // Import CallbackProperty
} from "cesium";
import { appConfig, i18n } from "./config.js";

// Utility to generate a random hex color
export function generateRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

export let viewer;
export const activeOverlays = new Map(); // Export activeOverlays
let currentBaseLayer = null;
let currentBaseLayerConfig = null;
let isDarkMode = false;
let isTerrainActive = false;
let contoursEnabled = false;
let contourSpacing = 100.0;

export function getBaseMaps() {
  return [
    {
      name: "OpenStreetMap",
      type: "xyz",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      category: i18n.worldLayersLabel || "World Layers",
    },
    {
      name: "ESRI World Topo",
      type: "arcgis",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer",
      category: i18n.worldLayersLabel || "World Layers",
    },
    ...(appConfig.imagery_layers || []),
  ];
}

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
  currentBaseLayerConfig = layerConfig;

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

function applyOverlayStyling(dataSource, layerName) {
  const saved = localStorage.getItem(`overlay_style_${layerName}`);
  if (!saved) return;
  try {
    const style = JSON.parse(saved);
    dataSource.entities.values.forEach((entity) => {
      if (entity.polyline) {
        if (style.color) entity.polyline.material = Color.fromCssColorString(style.color);
        if (style.width) entity.polyline.width = parseFloat(style.width);
      }
      if (entity.polygon) {
        // Apply fill style
        if (style.fillNone) {
          entity.polygon.material = Color.TRANSPARENT;
        } else if (style.fillColor) {
          const alpha = style.transparency !== undefined ? parseFloat(style.transparency) : 0.5;
          entity.polygon.material = Color.fromCssColorString(style.fillColor).withAlpha(alpha);
        }

        // Disable Cesium's native polygon outline (it won't render on terrain anyway)
        entity.polygon.outline = false;

        // Manage a separate polyline for the outline
        const outlineId = `${entity.id}-outline`;
        let outlinePolyline = dataSource.entities.getById(outlineId);

        if (style.borderNone) {
          if (outlinePolyline) {
            dataSource.entities.remove(outlinePolyline);
            console.warn(`Overlay ${layerName}, Entity ${entity.id}: Polyline outline removed (borderNone).`);
          }
        } else {
          // Get positions from the polygon hierarchy
          const hierarchy = entity.polygon.hierarchy.getValue(JulianDate.now());
          // Use hierarchy.positions for GeoJSON-like data, which contains the exterior ring directly
          if (hierarchy && hierarchy.positions && hierarchy.positions.length > 0) {
            const positions = hierarchy.positions;

            if (!outlinePolyline) {
              // Create new polyline
              outlinePolyline = dataSource.entities.add({
                id: outlineId,
                parent: entity, // Associate with the main entity
                polyline: {
                  positions: positions,
                  width: parseFloat(style.width),
                  material: Color.fromCssColorString(style.color),
                  clampToGround: true,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY, // Ensure polyline is always visible on top
                  pickable: false, // Make the outline non-pickable to prevent infobox
                },
                show: new CallbackProperty(() => {
                  // Safely check if the parent entity still exists and is shown
                  const parentEntity = dataSource.entities.getById(entity.id);
                  return parentEntity && parentEntity.show;
                }, false),
              });
              // Removed verbose log for polyline outline creation
            } else {
              // Update existing polyline
              outlinePolyline.polyline.positions = positions;
              outlinePolyline.polyline.width = parseFloat(style.width);
              outlinePolyline.polyline.material = Color.fromCssColorString(style.color);
              outlinePolyline.polyline.disableDepthTestDistance = Number.POSITIVE_INFINITY; // Ensure this is also set on update
              outlinePolyline.polyline.pickable = false; // Ensure it remains non-pickable on update
              // Ensure show property also uses CallbackProperty for dynamic updates
              outlinePolyline.show = new CallbackProperty(() => {
                const parentEntity = dataSource.entities.getById(entity.id);
                return parentEntity && parentEntity.show;
              }, false);
              // Removed verbose log for polyline outline update
            }
          } else {
            // Further enhanced logging to pinpoint the exact reason for skipping
            let reason = "unknown";
            if (!hierarchy) {
              reason = "hierarchy is null/undefined";
            } else if (!hierarchy.positions) {
              reason = "hierarchy.positions is null/undefined";
            } else if (!Array.isArray(hierarchy.positions)) {
              reason = `hierarchy.positions is not an array (type: ${typeof hierarchy.positions})`;
            } else if (hierarchy.positions.length === 0) {
              reason = "hierarchy.positions is an empty array";
            }
            console.warn(`Overlay ${layerName}, Entity ${entity.id}: Polyline outline skipped because: ${reason}. Full hierarchy object:`, hierarchy);

            if (outlinePolyline) {
              dataSource.entities.remove(outlinePolyline); // Ensure old polyline is removed if polygon becomes degenerate
            }
          }
        }
      }
    });
  } catch (e) {
    console.error("Failed to apply overlay styling", e);
  }
}

// List of all graphic property names on a Cesium Entity that can be pickable
const allGraphicPropertyNames = [
  "billboard", "box", "corridor", "cylinder", "ellipse", "ellipsoid",
  "label", "model", "path", "point", "polygon", "polyline",
  "polylineVolume", "rectangle", "wall"
];

export async function toggleOverlayLayer(layerConfig, active) {
  if (active) {
    if (!activeOverlays.has(layerConfig.name)) {
      if (layerConfig.type === "file") {
        let dataSource;
        try {
          if (layerConfig.file_type === "geojson") {
            dataSource = await GeoJsonDataSource.load(layerConfig.url, {
              clampToGround: true, // Reinstated to true for proper filling on terrain
              enablePickFeatures: false, // Disable picking for GeoJSON features
            });
          } else if (layerConfig.file_type === "kml") {
            dataSource = await KmlDataSource.load(layerConfig.url, {
              canvas: viewer.canvas,
              camera: viewer.camera,
              clampToGround: true, // Reinstated to true for proper filling on terrain
              enablePickFeatures: false, // Disable picking for KML features
            });
          } else if (layerConfig.file_type === "czml") {
            dataSource = await CzmlDataSource.load(layerConfig.url);
          }
          if (dataSource) {
            // Prefer internal name if available for UI consistency
            if (dataSource.name && dataSource.name !== "file") {
              layerConfig.displayName = dataSource.name;
            }

            applyOverlayStyling(dataSource, layerConfig.name);

            // Post-process entities for better visibility on terrain and disable picking
            dataSource.entities.values.forEach((entity) => {
              entity.pickable = false; // Disable infobox for the entity itself

              // Explicitly disable picking for all defined graphic properties
              allGraphicPropertyNames.forEach(propName => {
                if (entity[propName]) {
                  entity[propName].pickable = false;
                }
              });

              // Apply height reference and depth test distance for common clamped types
              // (These were previously duplicated, consolidating the picking here)
              if (entity.billboard) {
                entity.billboard.heightReference = HeightReference.CLAMP_TO_GROUND;
                entity.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;
              }
              if (entity.label) {
                entity.label.heightReference = HeightReference.CLAMP_TO_GROUND;
                entity.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
              }
              if (entity.point) {
                entity.point.heightReference = HeightReference.CLAMP_TO_GROUND;
                entity.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
              }
              if (entity.polyline) {
                entity.polyline.clampToGround = true;
              }
              if (entity.polygon) {
                entity.polygon.classificationType = ClassificationType.BOTH;
                // Native Cesium polygon outlines are incompatible with terrain clamping.
                // We handle outlines via a separate Polyline entity.
                entity.polygon.outline = false; // Explicitly disable native outline
              }
            });
            await viewer.dataSources.add(dataSource);
            activeOverlays.set(layerConfig.name, dataSource);
          }
        } catch (e) {
          console.error(`Failed to load overlay file ${layerConfig.name}:`, e);
        }
      } else {
        const provider = await createImageryProvider(layerConfig);
        const cesiumLayer = viewer.imageryLayers.addImageryProvider(provider);
        activeOverlays.set(layerConfig.name, cesiumLayer);
      }
    }
  } else {
    const overlay = activeOverlays.get(layerConfig.name);
    if (overlay) {
      if (layerConfig.type === "file") {
        viewer.dataSources.remove(overlay);
      } else {
        viewer.imageryLayers.remove(overlay);
      }
      activeOverlays.delete(layerConfig.name);
    }
  }
}

export function clearOverlayLayers() {
  activeOverlays.forEach((overlay) => {
    // We need to know the type to remove correctly. 
    // Since we don't store the config, we check for DataSource properties
    if (overlay && typeof overlay.show !== "undefined" && typeof overlay.entities !== "undefined") {
      viewer.dataSources.remove(overlay);
    } else {
      viewer.imageryLayers.remove(overlay);
    }
  });
  activeOverlays.clear();
}

export async function initViewer() {
  // console.log("Initializing Viewer. Current appConfig:", appConfig); // Removed verbose log

  const ionToken = appConfig.cesium_ion_token;
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  // Use a simple initial imagery provider to avoid startup failure
  const defaultBase = getBaseMaps().find((l) => l.name === "OpenStreetMap") || getBaseMaps()[0];
  const initialImagery = await createImageryProvider(defaultBase);

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

  // Zulu Clock
  const zuluClock = document.getElementById("zuluClock");
  if (zuluClock) {
    setInterval(() => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, "0");
      const m = String(now.getUTCMinutes()).padStart(2, "0");
      const s = String(now.getUTCSeconds()).padStart(2, "0");
      zuluClock.innerText = `${h}:${m}:${s}Z`;
    }, 1000);
  }

  currentBaseLayer = viewer.imageryLayers.get(0);
  currentBaseLayerConfig = defaultBase;

  const initialDestination = Cartesian3.fromDegrees(
    appConfig.initial_lon || 24.9384,
    appConfig.initial_lat || 60.1699,
    1000000.0,
  );

  viewer.camera.setView({
    destination: initialDestination,
  });

  return viewer;
}

export function getCameraState() {
  if (!viewer) return null;
  const camera = viewer.camera;
  return {
    position: camera.position.clone(),
    direction: camera.direction.clone(),
    up: camera.up.clone(),
    right: camera.right.clone(),
    transform: camera.transform.clone(),
  };
}

export function setCameraState(state) {
  if (!viewer || !state) return;
  viewer.camera.setView({
    destination: state.position,
    orientation: {
      direction: state.direction,
      up: state.up,
    },
  });
}

export function getLayerState() {
  return {
    baseLayerName: currentBaseLayerConfig ? currentBaseLayerConfig.name : null,
    terrainActive: isTerrainActive,
    overlays: Array.from(activeOverlays.keys()),
    contoursEnabled,
    contourSpacing,
  };
}
