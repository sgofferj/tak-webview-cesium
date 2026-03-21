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
  applyFilter,
  setFilters,
  throttledUpdateUnitList,
  updateEntitySelectionVisibility,
} from "./state.js";
import { startWebSocket } from "./websocket.js";

async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await startApp();
  }
}

async function startApp() {
  await loadConfig();
  await loadTranslations();
  await initViewer();
  setupEvents();
  populateLayerPicker();
  startWebSocket();
}

async function checkAuth() {
  const overlay = document.getElementById("authOverlay");
  const loginForm = document.getElementById("loginForm");
  const enrollmentForm = document.getElementById("enrollmentForm");
  const statusBar = document.getElementById("statusBar");

  overlay.classList.remove("hidden");

  try {
    const resp = await fetch("/api/auth/status");
    const status = await resp.json();

    if (status.authenticated) {
      overlay.classList.add("hidden");
      statusBar.classList.remove("hidden");
      updateStatus(status);
      setupAuthEvents();
      return true;
    }

    if (status.enrolled) {
      loginForm.classList.remove("hidden");
      enrollmentForm.classList.add("hidden");
      document.getElementById("loginUser").focus();
    } else {
      enrollmentForm.classList.remove("hidden");
      loginForm.classList.add("hidden");
      document.getElementById("enrollServer").focus();
    }
    setupAuthEvents();
    return false;
  } catch {
    console.error("Auth check failed");
    return false;
  }
}

function updateStatus(status) {
  if (status.cert) {
    const cn = document.getElementById("certCN");
    const expiry = document.getElementById("certExpiry");
    cn.innerText = status.cert.cn;
    expiry.innerText = status.cert.expiry.split("T")[0];
    expiry.className = `status-${status.cert.status}`;
  }
}

function setupAuthEvents() {
  if (window.authListenersAttached) return;
  window.authListenersAttached = true;

  const message = document.getElementById("authMessage");

  const triggerEnroll = async () => {
    const server = document.getElementById("enrollServer").value;
    const username = document.getElementById("enrollUser").value;
    const password = document.getElementById("enrollPass").value;
    message.classList.add("hidden");

    try {
      const resp = await fetch("/api/auth/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server, username, password }),
      });
      if (resp.ok) {
        init(); // Re-run init to start app
      } else {
        const err = await resp.json();
        message.innerText = err.detail || "Enrollment failed";
        message.classList.remove("hidden");
      }
    } catch {
      message.innerText = "Connection error";
      message.classList.remove("hidden");
    }
  };

  const triggerLogin = async () => {
    const username = document.getElementById("loginUser").value;
    const password = document.getElementById("loginPass").value;
    message.classList.add("hidden");

    try {
      const resp = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (resp.ok) {
        init(); // Re-run init to start app
      } else {
        const err = await resp.json();
        message.innerText = err.detail || "Login failed";
        message.classList.remove("hidden");
        if (resp.status === 401) checkAuth();
      }
    } catch {
      message.innerText = "Connection error";
      message.classList.remove("hidden");
    }
  };

  document
    .getElementById("enrollButton")
    .addEventListener("click", triggerEnroll);

  document.getElementById("enrollPass").addEventListener("keyup", (e) => {
    if (e.key === "Enter") triggerEnroll();
  });

  document
    .getElementById("loginButton")
    .addEventListener("click", triggerLogin);

  document.getElementById("loginPass").addEventListener("keyup", (e) => {
    if (e.key === "Enter") triggerLogin();
  });

  document.getElementById("authLogout").addEventListener("click", async () => {
    document.getElementById("authOverlay").classList.remove("hidden");
    document.getElementById("statusBar").classList.add("hidden");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      console.error("Logout failed");
    }
    location.reload();
  });

  document.getElementById("authForget").addEventListener("click", async () => {
    if (
      confirm(
        "Are you sure you want to forget this enrollment? This will wipe all session certificates.",
      )
    ) {
      document.getElementById("authOverlay").classList.remove("hidden");
      document.getElementById("statusBar").classList.add("hidden");
      try {
        await fetch("/api/auth/logout-wipe", { method: "POST" });
      } catch {
        console.error("Forget failed");
      }
      location.reload();
    }
  });
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
      const isActive = opt.isTerrain === false;
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
    updateEntitySelectionVisibility(entity);

    const infoBox = document.querySelector(".cesium-infoBox");
    if (infoBox) {
      infoBox.classList.remove("emergency-active");
    }

    // Refresh all visibility states (labels, trails, course arrows) on selection change
    applyFilter();

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

  const updateZoom = () => {
    const height = viewer.camera.positionCartographic.height;
    const zoom = Math.floor(Math.log2(35200000 / height));
    const zoomEl = document.getElementById("statusZoom");
    if (zoomEl) zoomEl.innerText = `Z${Math.max(0, zoom)}`;
    
    // Update filters to refresh visibility (including zoom-dependent labels)
    applyFilter();
  };
  viewer.camera.changed.addEventListener(updateZoom);
  updateZoom();

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
    // Set minimum height of 15km to prevent 'doomzoom'
    const resetHeight = Math.max(center.height, 15000.0);
    viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        resetHeight,
      ),
      orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
    });
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
    } catch {
      body.innerHTML = "Failed to load information.";
    }
    modal.classList.remove("modal-hidden");
  });

  document.getElementById("closeInfo").addEventListener("click", () => {
    document.getElementById("infoModal").classList.add("modal-hidden");
  });

  // Minimize panels when clicking outside
  document.addEventListener("click", (e) => {
    const layerPickerPanel = document.getElementById("layerPickerPanel");
    const toggleLayerPicker = document.getElementById("toggleLayerPicker");
    if (
      !layerPickerPanel.classList.contains("hidden") &&
      !layerPickerPanel.contains(e.target) &&
      !toggleLayerPicker.contains(e.target)
    ) {
      layerPickerPanel.classList.add("hidden");
    }
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
