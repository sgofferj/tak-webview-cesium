import {
  Viewer,
  Ion,
  WebMapServiceImageryProvider,
  ProviderViewModel,
  OpenStreetMapImageryProvider,
  ArcGisMapServerImageryProvider,
  WebMercatorTilingScheme,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  buildModuleUrl,
  Cartesian3,
  Rectangle,
} from "cesium";
import { appConfig, i18n } from "./config.js";

export let viewer;

export async function initViewer() {
  const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
  if (ionToken) {
    Ion.defaultAccessToken = ionToken;
  }

  const imageryViewModels = [];
  if (!ionToken) {
    imageryViewModels.push(
      new ProviderViewModel({
        name: "OpenStreetMap",
        iconUrl: "https://a.tile.openstreetmap.org/0/0/0.png",
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

  if (appConfig.imagery_layers) {
    appConfig.imagery_layers.forEach((layer) => {
      let rect = Rectangle.MAX_VALUE;
      if (layer.rectangle && layer.rectangle.length === 4) {
        rect = Rectangle.fromDegrees(...layer.rectangle);
      }
      imageryViewModels.push(
        new ProviderViewModel({
          name: layer.name,
          iconUrl: layer.icon,
          tooltip: layer.name,
          category: layer.category || "Custom",
          creationFunction: () => [
            new OpenStreetMapImageryProvider({
              url: "https://a.tile.openstreetmap.org/",
            }),
            new WebMapServiceImageryProvider({
              url: layer.url,
              layers: layer.layers,
              rectangle: rect,
              tilingScheme: new WebMercatorTilingScheme(),
              enablePickFeatures: false,
              parameters: { transparent: "true", format: "image/png" },
            }),
          ],
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

  let initialDestination = Cartesian3.fromDegrees(24.9384, 60.1699, 2000000.0);
  if (appConfig.imagery_layers && appConfig.imagery_layers.length > 0) {
    const firstLayer = appConfig.imagery_layers[0];
    if (firstLayer.rectangle && firstLayer.rectangle.length === 4) {
      const rect = Rectangle.fromDegrees(...firstLayer.rectangle);
      const center = Rectangle.center(rect);
      initialDestination = Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        2000000.0,
      );
    }
  }

  viewer.camera.setView({
    destination: initialDestination,
  });

  return viewer;
}
