// main.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import { Cartesian3, buildModuleUrl } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadConfig, loadTranslations, appConfig, i18n } from "./config.js";
import {
  initViewer,
  viewer,
  setBaseLayer,
  setTerrain,
  toggleOverlayLayer,
  clearOverlayLayers,
} from "./viewer.js";
import {
  entityState,
  showAllTrails,
  setFilters,
  setShowAllTrails,
  calculateTrailVisibility,
  throttledUpdateUnitList,
} from "./state.js";
import { startWebSocket } from "./websocket.js";

async function init() {
  await loadConfig();
  await loadTranslations();
  await initViewer();
  setupEvents();
  populateLayerPicker();
  startWebSocket();
}

function createLayerItem(l, isRadio, nameGroup, isActive) {
  const item = document.createElement("div");
  item.className = `layer-item ${isActive ? "active" : ""}`;

  let iconUrl = l.icon;
  if (!iconUrl) {
    if (l.name === "OpenStreetMap") {
      iconUrl = buildModuleUrl(
        "Widgets/Images/ImageryProviders/openStreetMap.png",
      );
    } else if (l.name === "ESRI World Topo") {
      iconUrl =
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/0/0/0";
    } else {
      iconUrl = buildModuleUrl(
        "Widgets/Images/ImageryProviders/openStreetMap.png",
      );
    }
  }

  item.innerHTML = `
        <div class="layer-thumb" style="background-image: url('${iconUrl}')"></div>
        <div class="layer-label">${l.name}</div>
        <input type="${isRadio ? "radio" : "checkbox"}" name="${nameGroup}" ${isActive ? "checked" : ""}>
    `;

  return item;
}

function populateLayerPicker() {
  const baseMapGrid = document.getElementById("baseMapGrid");
  const overlayGrid = document.getElementById("overlayGrid");
  const terrainGrid = document.getElementById("terrainGrid");
  const terrainSection = document.getElementById("terrainSection");

  // Populate Terrain
  if (appConfig.terrain_url) {
    const terrainOptions = [
      {
        name: i18n.ellipsoidLabel || "WGS84 Ellipsoid",
        icon: buildModuleUrl("Widgets/Images/TerrainProviders/Ellipsoid.png"),
        isTerrain: false,
      },
      {
        name: i18n.terrainLabel || "Terrain",
        icon: buildModuleUrl(
          "Widgets/Images/TerrainProviders/CesiumWorldTerrain.png",
        ),
        isTerrain: true,
      },
    ];

    terrainOptions.forEach((opt) => {
      const isActive = opt.isTerrain === false; // Default to terrain OFF (Ellipsoid ON)
      const item = createLayerItem(opt, true, "terrainLayer", isActive);
      item.addEventListener("click", async () => {
        terrainGrid
          .querySelectorAll(".layer-item")
          .forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
        item.querySelector("input").checked = true;
        await setTerrain(opt.isTerrain);
      });
      terrainGrid.appendChild(item);
    });
  } else {
    terrainSection.classList.add("hidden");
  }

  const baseMaps = [
    {
      name: "OpenStreetMap",
      type: "xyz",
      url: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
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

  // Group Base Maps by Category
  const groupedBase = {};
  baseMaps.forEach((l) => {
    const cat = l.category || "Other";
    if (!groupedBase[cat]) groupedBase[cat] = [];
    groupedBase[cat].push(l);
  });

  Object.entries(groupedBase).forEach(([cat, layers]) => {
    const title = document.createElement("div");
    title.className = "layer-category-title";
    title.innerText = cat;
    baseMapGrid.appendChild(title);

    layers.forEach((l) => {
      const isActive = l.name === "OpenStreetMap";
      const item = createLayerItem(l, true, "baseLayer", isActive);

      // Fix: Ensure the default layer is explicitly set in Cesium on startup
      if (isActive) {
        setBaseLayer(l);
      }

      item.addEventListener("click", () => {
        baseMapGrid
          .querySelectorAll(".layer-item")
          .forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
        item.querySelector("input").checked = true;
        setBaseLayer(l);
      });
      baseMapGrid.appendChild(item);
    });
  });

  // Populate Overlays
  const noneOverlay = { name: "None", icon: null };
  const noneItem = createLayerItem(noneOverlay, false, "none", false);
  noneItem.querySelector(".layer-thumb").style.backgroundColor = "#222";
  noneItem.querySelector(".layer-thumb").innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:2.5em;color:#444;">Ø</div>';
  noneItem.addEventListener("click", () => {
    clearOverlayLayers();
    overlayGrid
      .querySelectorAll(".layer-item")
      .forEach((el) => el.classList.remove("active"));
    overlayGrid
      .querySelectorAll("input")
      .forEach((input) => (input.checked = false));
  });
  overlayGrid.appendChild(noneItem);

  if (appConfig.overlay_layers && appConfig.overlay_layers.length > 0) {
    appConfig.overlay_layers.forEach((l) => {
      const item = createLayerItem(l, false, "overlayLayer", false);
      item.addEventListener("click", (e) => {
        const input = item.querySelector("input");
        if (e.target !== input) {
          input.checked = !input.checked;
        }
        if (input.checked) {
          item.classList.add("active");
        } else {
          item.classList.remove("active");
        }
        toggleOverlayLayer(l, input.checked);
      });
      overlayGrid.appendChild(item);
    });
  }
}

function setupEvents() {
  viewer.selectedEntityChanged.addEventListener((entity) => {
    const infoBox = document.querySelector(".cesium-infoBox");
    if (infoBox) {
      infoBox.classList.remove("emergency-active");
    }
    Object.keys(entityState).forEach((uid) => {
      const state = entityState[uid];
      if (state.trailEntity) {
        state.trailEntity.show = calculateTrailVisibility(uid);
      }
    });
    if (entity) {
      const state = entityState[entity.id];
      if (
        state &&
        state.lastData &&
        state.lastData.emergency &&
        state.lastData.emergency.status === "active"
      ) {
        if (infoBox) infoBox.classList.add("emergency-active");
      }
      const checkIframe = setInterval(() => {
        const iframe = viewer.infoBox.frame;
        if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
          const style = iframe.contentDocument.createElement("style");
          style.textContent = `
                            html, body { 
                                overflow-y: auto !important; 
                                overflow-x: hidden !important;
                                height: 100% !important; 
                                min-height: 100% !important;
                                margin: 0; 
                                padding: 0; 
                                color: white; 
                                font-family: sans-serif; 
                                background: transparent;
                            }
                            .cesium-infoBox-description { 
                                padding: 10px; 
                                min-height: 100%;
                                box-sizing: border-box;
                            }
                        `;
          iframe.contentDocument.head.appendChild(style);

          iframe.contentDocument.body.onclick = (e) => {
            if (e.target.classList.contains("hashtag-link")) {
              e.preventDefault();
              window.filterByTag(e.target.getAttribute("data-tag"));
            }
          };
          clearInterval(checkIframe);
        }
      }, 100);
      setTimeout(() => clearInterval(checkIframe), 3000);
    }
  });

  document.getElementById("filterInput").addEventListener("input", (e) => {
    setFilters(e.target.value, undefined);
  });
  document
    .getElementById("affiliationFilter")
    .addEventListener("change", (e) => {
      setFilters(undefined, e.target.value);
    });
  document.getElementById("clearFilter").addEventListener("click", () => {
    document.getElementById("filterInput").value = "";
    document.getElementById("affiliationFilter").value = "all";
    setFilters("", "all");
  });
  document.getElementById("resetView").addEventListener("click", () => {
    viewer.trackedEntity = undefined;
    const center = viewer.camera.positionCartographic;
    viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        center.height,
      ),
      orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
    });
  });

  document.getElementById("toggleTrails").addEventListener("click", (e) => {
    const newVal = !showAllTrails;
    setShowAllTrails(newVal);
    e.target.innerText = newVal ? i18n.trailsButtonOn : i18n.trailsButtonOff;
  });

  document.getElementById("toggleUnitList").addEventListener("click", () => {
    document.getElementById("unitListPanel").classList.toggle("hidden");
    throttledUpdateUnitList();
  });

  document.getElementById("toggleLayerPicker").addEventListener("click", () => {
    document.getElementById("layerPickerPanel").classList.toggle("hidden");
  });

  document.getElementById("showInfo").addEventListener("click", async () => {
    const modal = document.getElementById("infoModal");
    const body = document.getElementById("infoBody");
    try {
      const response = await fetch("/info.html");
      body.innerHTML = await response.text();
    } catch (e) {
      body.innerHTML = "Failed to load information.";
    }
    modal.classList.remove("modal-hidden");
  });

  document.getElementById("closeInfo").addEventListener("click", () => {
    document.getElementById("infoModal").classList.add("modal-hidden");
  });
}

window.filterByTag = function (tag) {
  const filterInput = document.getElementById("filterInput");
  if (filterInput) {
    filterInput.value = tag;
    setFilters(tag, undefined);
  }
};

init();
