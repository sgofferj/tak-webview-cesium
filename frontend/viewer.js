import {
  Viewer,
  Ion,
  WebMapServiceImageryProvider,
  ProviderViewModel,
  OpenStreetMapImageryProvider,
  ArcGisMapServerImageryProvider,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  buildModuleUrl,
  Cartesian3,
  Rectangle,
  Credit,
} from "cesium";
import { appConfig, i18n } from "./config.js";

export let viewer;

export async function initViewer() {
  console.log("Initializing Viewer. Current appConfig:", appConfig);

  const ionToken = appConfig.cesium_ion_token;
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  const imageryViewModels = [];

  // 1. ALWAYS ADD WORLD LAYERS FIRST (so they appear on top)
  if (!ionToken) {
    console.log("Adding standard World Layers.");
    imageryViewModels.push(
      new ProviderViewModel({
        name: "OpenStreetMap",
        iconUrl: buildModuleUrl(
          "Widgets/Images/ImageryProviders/openStreetMap.png",
        ),
        tooltip: "OpenStreetMap",
        category: i18n.worldLayersLabel || "World Layers",
        creationFunction: () =>
          new OpenStreetMapImageryProvider({
            url: "https://a.tile.openstreetmap.org/",
          }),
      }),
    );
    imageryViewModels.push(
      new ProviderViewModel({
        name: "ESRI World Topo",
        iconUrl:
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/0/0/0",
        tooltip: "ESRI World Topographical Map",
        category: i18n.worldLayersLabel || "World Layers",
        creationFunction: () =>
          ArcGisMapServerImageryProvider.fromUrl(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer",
            { enablePickFeatures: false },
          ),
      }),
    );
  }

  // 2. ADD CUSTOM LAYERS
  if (appConfig.imagery_layers && appConfig.imagery_layers.length > 0) {
    console.log("Processing custom layers from config...");
    appConfig.imagery_layers.forEach((layer) => {
      // Avoid duplicating OSM if it's in the custom config
      if (
        layer.name === "OpenStreetMap" ||
        layer.url.includes("openstreetmap.org")
      ) {
        return;
      }

      console.log(
        `Configuring layer: ${layer.name} (Category: ${layer.category || "Custom"})`,
      );
      let rect = Rectangle.MAX_VALUE;
      if (layer.rectangle && layer.rectangle.length === 4) {
        rect = Rectangle.fromDegrees(...layer.rectangle);
      }

      const credit = layer.attribution
        ? new Credit(layer.attribution)
        : undefined;
      const fallbackIcon = buildModuleUrl(
        "Widgets/Images/ImageryProviders/openStreetMap.png",
      );

      imageryViewModels.push(
        new ProviderViewModel({
          name: layer.name,
          iconUrl: layer.icon || fallbackIcon,
          tooltip: layer.name,
          category: layer.category || "Custom",
          creationFunction: () => {
            console.log(
              `Creating imagery provider for: ${layer.name} (${layer.type})`,
            );
            try {
              switch (layer.type) {
                case "wms":
                  return [
                    new OpenStreetMapImageryProvider({
                      url: "https://a.tile.openstreetmap.org/",
                    }),
                    new WebMapServiceImageryProvider({
                      url: layer.url,
                      layers: layer.layers,
                      rectangle: rect,
                      tilingScheme: new WebMercatorTilingScheme(),
                      enablePickFeatures: false,
                      credit: credit,
                      parameters: { transparent: "true", format: "image/png" },
                    }),
                  ];
                case "xyz":
                case "tms":
                  return new UrlTemplateImageryProvider({
                    url: layer.url,
                    rectangle: rect,
                    credit: credit,
                  });
                case "arcgis":
                  return ArcGisMapServerImageryProvider.fromUrl(layer.url, {
                    enablePickFeatures: false,
                    credit: credit,
                  });
                default:
                  console.warn(
                    `Unknown imagery type: ${layer.type} for layer ${layer.name}`,
                  );
                  return new OpenStreetMapImageryProvider({
                    url: "https://a.tile.openstreetmap.org/",
                  });
              }
            } catch (e) {
              console.error(
                `Failed to create imagery provider for ${layer.name}:`,
                e,
              );
              return new OpenStreetMapImageryProvider({
                url: "https://a.tile.openstreetmap.org/",
              });
            }
          },
        }),
      );
    });
  }

  const terrainViewModels = [];
  if (appConfig.terrain_url) {
    terrainViewModels.push(
      new ProviderViewModel({
        name: i18n.ellipsoidLabel || "WGS84 Ellipsoid",
        iconUrl: buildModuleUrl(
          "Widgets/Images/TerrainProviders/Ellipsoid.png",
        ),
        tooltip: "WGS84 Ellipsoid",
        category: "Terrain",
        creationFunction: () => new EllipsoidTerrainProvider(),
      }),
    );
    terrainViewModels.push(
      new ProviderViewModel({
        name: i18n.terrainLabel || "Terrain",
        iconUrl: buildModuleUrl(
          "Widgets/Images/TerrainProviders/CesiumWorldTerrain.png",
        ),
        tooltip: "Custom Terrain",
        category: "Terrain",
        creationFunction: () =>
          CesiumTerrainProvider.fromUrl(appConfig.terrain_url),
      }),
    );
  }

  console.log(
    "Instantiating Cesium Viewer with",
    imageryViewModels.length,
    "imagery providers.",
  );
  viewer = new Viewer("cesiumContainer", {
    terrainProvider: undefined,
    baseLayerPicker: true,
    imageryProviderViewModels:
      imageryViewModels.length > 0 ? imageryViewModels : undefined,
    selectedImageryProviderViewModel:
      imageryViewModels.length > 0 ? imageryViewModels[0] : undefined,
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    infoBox: true,
    selectionIndicator: true,
    navigationHelpButton: false,
    sceneModePicker: true,
    terrainProviderViewModels: terrainViewModels,
    selectedTerrainProviderViewModel:
      terrainViewModels.length > 0 ? terrainViewModels[0] : undefined,
    terrainExaggeration: appConfig.terrain_exaggeration || 1.0,
    terrainExaggerationRelativeHeight: 0.0,
  });

  let initialDestination = Cartesian3.fromDegrees(24.9384, 60.1699, 1000000.0);
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
