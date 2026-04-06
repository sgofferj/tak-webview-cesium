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
  getBaseMaps,
  setBaseLayer,
  setTerrain,
  toggleOverlayLayer,
  clearOverlayLayers,
  setElevationContours,
  setContourSpacing,
  getCameraState,
  setCameraState,
  getLayerState,
  generateRandomColor,
  activeOverlays, // Import activeOverlays
} from "./viewer.js";
import {
  entityState,
  applyFilter,
  setFilters,
  getFilters,
  updateEntitySelectionVisibility,
  setCameraTilt,
  setTabVisibility,
  updateStaffCommentsUI, // Import updateStaffCommentsUI
  initStateManager,
} from "./state.js";
import { startWebSocket } from "./websocket.js";

async function init() {
  const authenticated = await checkAuth();
  if (authenticated) {
    await startApp();
  }
}

function saveAppState() {
  if (!viewer) return;
  const state = {
    camera: getCameraState(),
    layers: getLayerState(),
    filters: getFilters(),
  };
  localStorage.setItem("tak_map_state", JSON.stringify(state));
  updateLayerPickerUI();
}

async function loadAppState() {
  const saved = localStorage.getItem("tak_map_state");
  if (!saved) return false;
  try {
    const state = JSON.parse(saved);

    // Restore Camera
    if (state.camera) {
      setCameraState(state.camera);
    }

    // Restore Filters
    if (state.filters) {
      setFilters(state.filters);
      const filterInput = document.getElementById("filterInput");
      const affFilter = document.getElementById("affiliationFilter");
      const dimFilter = document.getElementById("dimensionFilter");
      if (filterInput) filterInput.value = state.filters.text || "";
      if (affFilter) affFilter.value = state.filters.affiliation || "all";
      if (dimFilter && state.filters.dimension) dimFilter.value = state.filters.dimension;
    }

    // Restore Layers
    if (state.layers) {
      // Base Layer
      const allBaseLayers = getBaseMaps();
      const bl = allBaseLayers.find(
        (l) => l.name === state.layers.baseLayerName,
      );
      if (bl) {
        await setBaseLayer(bl);
      } else {
        // Fallback to default if saved not found
        const defaultBase = allBaseLayers.find((l) => l.name === "OpenStreetMap") || allBaseLayers[0];
        if (defaultBase) await setBaseLayer(defaultBase);
      }

      // Terrain
      if (state.layers.terrainActive !== undefined) {
        await setTerrain(state.layers.terrainActive);
      }

      // Overlays
      if (state.layers.overlays && appConfig.overlay_layers) {
        for (const ovName of state.layers.overlays) {
          const ov = appConfig.overlay_layers.find((l) => l.name === ovName);
          if (ov) await toggleOverlayLayer(ov, true);
        }
      }

      // Analysis
      if (state.layers.contoursEnabled) {
        setContourSpacing(state.layers.contourSpacing || 100);
        setElevationContours(true);
      }
    }

    // Re-sync UI
    updateLayerPickerUI();
    return true;
  } catch (e) {
    console.error("Failed to load saved state", e);
    return false;
  }
}

function updateLayerPickerUI() {
  const layerState = getLayerState();
  const panel = document.getElementById("layerPickerPanel");
  if (!panel) return;

  const labels = {
    terrain: i18n.terrainLabel || "Terrain",
    ellipsoid: i18n.ellipsoidLabel || "WGS84 Ellipsoid",
  };

  panel.querySelectorAll(".layer-item").forEach((item) => {
    const name = item.getAttribute("data-layer-name"); // Use data-layer-name for consistency
    const input = item.querySelector("input");

    if (item.classList.contains("baseLayer")) {
      const active = name === layerState.baseLayerName?.trim();
      item.classList.toggle("active", active);
      if (input) input.checked = active;
    } else if (item.classList.contains("terrainLayer")) {
      const isTerrainOption = name === labels.terrain || name === i18n.terrainLabel;
      const isEllipsoidOption = name === labels.ellipsoid || name === i18n.ellipsoidLabel;
      const active =
        (isTerrainOption && layerState.terrainActive) ||
        (isEllipsoidOption && !layerState.terrainActive);

      item.classList.toggle("active", active);
      if (input) input.checked = active;
    } else if (item.classList.contains("overlayLayer")) {
      const active = layerState.overlays.includes(name);
      item.classList.toggle("active", active);
      if (input) input.checked = active;
    }
  });
}

async function startApp() {
  await loadConfig();
  await loadTranslations();
  await initViewer();
  initStateManager();
  setupEvents();
  // Ensure no entity is selected initially to prevent trails from showing
  viewer.selectedEntity = undefined; 
  populateLayerPicker();

  // Try to load state
  const loaded = await loadAppState();

  // Fallback: if no state, apply sensible defaults
  if (!loaded) {
    const defaultBase = getBaseMaps().find((l) => l.name === "OpenStreetMap");
    if (defaultBase) await setBaseLayer(defaultBase);
    await setTerrain(false);
    updateLayerPickerUI();
  }
  // Ensure filters are applied after loading app state (or defaults) to correctly set visibility
  applyFilter();

  startWebSocket();
  // After websocket starts and entities begin flowing in, we need to ensure their visibility is set
  // This helps catch any entities that might have been processed by throttledReconcileForegroundEntities
  // before the first general applyFilter from setTabVisibility.
  applyFilter(); 
  
  // Initialize staff comments UI after config and translations are loaded
  updateStaffCommentsUI(); 

  // FINAL SANITY CHECK: Ensure no entity is selected after initialization is complete.
  // This robustly prevents trails from showing on load due to any race conditions
  // with entity creation or state loading.
  viewer.selectedEntity = undefined;

  // Start auto-save
  viewer.camera.moveEnd.addEventListener(saveAppState);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // console.debug("Tab backgrounded: pausing rendering loop");
      viewer.useDefaultRenderLoop = false;
      setTabVisibility(false);
    } else {
      // console.debug("Tab focused: resuming rendering loop");
      viewer.useDefaultRenderLoop = true;
      setTabVisibility(true);
    }
  });
}

export async function checkAuth() {
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
  } catch (e) {
    console.error("Auth check failed", e);
    const loginForm = document.getElementById("loginForm");
    const enrollmentForm = document.getElementById("enrollmentForm");
    if (loginForm && enrollmentForm) {
      enrollmentForm.classList.remove("hidden");
      loginForm.classList.add("hidden");
    }
    setupAuthEvents();
    return false;
  }
}

function updateStatus(status) {
  if (status.cert) {
    const cn = document.getElementById("certCN");
    const expiry = document.getElementById("certExpiry");
    if (cn) {
      cn.innerText = status.cert.cn;
      cn.className = `status-${status.cert.status}`;
    }
    if (expiry) {
      expiry.innerText = status.cert.expiry.split("T")[0];
      expiry.className = `status-${status.cert.status}`;
    }
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
  item.className = `layer-item ${nameGroup} ${isActive ? "active" : ""}`;
  item.setAttribute("data-layer-name", l.name); // Store original name for identification

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
        <input type="${isRadio ? "radio" : "checkbox"}" id="${nameGroup === 'overlayLayer' ? `overlay-${CSS.escape(l.name)}` : ''}" name="${nameGroup}" ${
          isActive ? "checked" : ""
        }>
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
      const item = createLayerItem(opt, true, "terrainLayer", false);
      item.addEventListener("click", async () => {
        terrainGrid
          .querySelectorAll(".layer-item")
          .forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
        item.querySelector("input").checked = true;
        await setTerrain(opt.isTerrain);
        saveAppState();
      });
      terrainGrid.appendChild(item);
    });
  } else {
    terrainSection.classList.add("hidden");
  }

  const groupedBase = {};
  getBaseMaps().forEach((l) => {
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
      const item = createLayerItem(l, true, "baseLayer", false);

      item.addEventListener("click", async () => {
        await setBaseLayer(l);
        saveAppState();
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
    saveAppState();
  });
  overlayGrid.appendChild(noneItem);

  if (appConfig.overlay_layers && appConfig.overlay_layers.length > 0) {
    appConfig.overlay_layers.forEach((l) => {
      const item = createLayerItem(l, false, "overlayLayer", false);

      // Handle internal name preference for label
      if (l.displayName) {
        const label = item.querySelector(".layer-label");
        if (label) label.innerText = l.displayName;
      }

      // Re-enabling left click response for file overlays as the previous change was based on a misunderstanding.
      // The InfoBox for map clicks on overlays is already handled by viewer.selectedEntityChanged.
      item.addEventListener("click", async (e) => {
        const input = item.querySelector("input");
        if (e.target !== input) {
          input.checked = !input.checked;
        }
        if (input.checked) {
          item.classList.add("active");
        } else {
          item.classList.remove("active");
        }
        await toggleOverlayLayer(l, input.checked);
        saveAppState();
      });

      // Right-click styling modal
      if (l.type === "file") {
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showOverlayStyleModal(l);
        });
      }

      overlayGrid.appendChild(item);
    });
  } else {
    const noOverlaysMessage = document.createElement("div");
    noOverlaysMessage.style.cssText = "grid-column: 1 / -1; text-align: center; color: #888; font-size: 0.8em; padding: 10px;";
    noOverlaysMessage.innerText = i18n.noOverlaysMessage || "No overlay files found.";
    overlayGrid.appendChild(noOverlaysMessage);
  }

  // Analysis Section
  const analysisGrid = document.getElementById("analysisGrid");
  const contourOpt = {
    name: i18n.contoursLabel || "Contours",
    icon: null, // We'll use a CSS placeholder
  };
  const contourItem = createLayerItem(contourOpt, false, "analysisLayer", false);
  contourItem.querySelector(".layer-thumb").style.backgroundColor = "#111";
  contourItem.querySelector(".layer-thumb").innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:5px;">
      <div style="width:60%;height:2px;background:cyan;opacity:0.8;border-radius:1px;"></div>
      <div style="width:40%;height:2px;background:cyan;opacity:0.6;border-radius:1px;"></div>
      <div style="width:70%;height:2px;background:cyan;opacity:0.9;border-radius:1px;"></div>
    </div>
  `;

  const updateContourUI = (active) => {
    const settingsDiv = document.getElementById("contourSettings");
    const input = contourItem.querySelector("input");
    input.checked = active;
    if (active) {
      contourItem.classList.add("active");
      settingsDiv.classList.remove("hidden");
    } else {
      contourItem.classList.remove("active");
      settingsDiv.classList.add("hidden");
    }
  };

  window.addEventListener("contoursChanged", (e) => {
    updateContourUI(e.detail.active);
  });

  contourItem.addEventListener("click", (e) => {
    const input = contourItem.querySelector("input");
    let targetState = input.checked;
    if (e.target !== input) {
      targetState = !input.checked;
    }
    setElevationContours(targetState);
    saveAppState();
  });
  analysisGrid.appendChild(contourItem);

  // Contour Density Controls
  let currentDensity = 100;
  const valueSpan = document.getElementById("contourValue");

  document.getElementById("contourDec").addEventListener("click", (e) => {
    e.stopPropagation();
    currentDensity = Math.max(5, currentDensity - 5);
    valueSpan.innerText = `${currentDensity}m`;
    setContourSpacing(currentDensity);
    saveAppState();
  });

  document.getElementById("contourInc").addEventListener("click", (e) => {
    e.stopPropagation();
    currentDensity += 5;
    valueSpan.innerText = `${currentDensity}m`;
    setContourSpacing(currentDensity);
    saveAppState();
  });

  // Attach event listener for click outside modals
  document.addEventListener("click", (e) => {
    const overlayStyleModal = document.getElementById("overlayStyleModal");
    if (
      overlayStyleModal &&
      !overlayStyleModal.classList.contains("modal-hidden") &&
      !overlayStyleModal.contains(e.target) &&
      e.target.id !== "saveOverlayStyle" &&
      e.target.id !== "closeOverlayStyle"
    ) {
      overlayStyleModal.classList.add("modal-hidden");
    }
  }, true); // Use capture phase to ensure it runs before other click handlers

}

function showOverlayStyleModal(layer) {
  const modal = document.getElementById("overlayStyleModal");
  if (!modal) return;

  const colorInput = document.getElementById("overlayColor");
  const borderNoneCheckbox = document.getElementById("overlayBorderNone"); // New checkbox
  const fillColorInput = document.getElementById("overlayFillColor");
  const fillNoneCheckbox = document.getElementById("overlayFillNone");
  const transparencyInput = document.getElementById("overlayTransparency");
  const widthInput = document.getElementById("overlayWidth");
  const saveBtn = document.getElementById("saveOverlayStyle");

  const saved = localStorage.getItem(`overlay_style_${layer.name}`);
  let currentStyle;
  if (saved) {
    currentStyle = JSON.parse(saved);
    // Ensure all properties exist from older saves
    currentStyle.color = currentStyle.color || "#00ffff";
    currentStyle.borderNone = currentStyle.borderNone || false; // New property
    currentStyle.fillColor = currentStyle.fillColor || "#00ffff";
    currentStyle.width = currentStyle.width !== undefined ? currentStyle.width : 2;
    currentStyle.fillNone = currentStyle.fillNone || false;
    currentStyle.transparency = currentStyle.transparency !== undefined ? currentStyle.transparency : 0.5; // Default transparency for fill
  } else {
    // Generate random color if no saved style
    const randomColor = generateRandomColor();
    currentStyle = { color: randomColor, borderNone: false, fillColor: randomColor, width: 2, fillNone: false, transparency: 0.5 };
  }

  colorInput.value = currentStyle.color;
  borderNoneCheckbox.checked = currentStyle.borderNone; // Set state of new checkbox
  fillColorInput.value = currentStyle.fillColor;
  fillNoneCheckbox.checked = currentStyle.fillNone;
  transparencyInput.value = currentStyle.transparency * 100; // Convert to percentage
  widthInput.value = currentStyle.width;

  // Event listener for borderNoneCheckbox
  borderNoneCheckbox.onchange = () => {
    colorInput.disabled = borderNoneCheckbox.checked;
    widthInput.disabled = borderNoneCheckbox.checked;
  };
  // Initialize disabled state for border controls
  colorInput.disabled = borderNoneCheckbox.checked;
  widthInput.disabled = borderNoneCheckbox.checked;

  // Add event listener for fillNoneCheckbox (existing)
  fillNoneCheckbox.onchange = () => {
    fillColorInput.disabled = fillNoneCheckbox.checked;
    transparencyInput.disabled = fillNoneCheckbox.checked;
  };
  // Initialize disabled state (existing)
  fillColorInput.disabled = fillNoneCheckbox.checked;
  transparencyInput.disabled = fillNoneCheckbox.checked;

  saveBtn.onclick = async () => {
    const style = {
      color: colorInput.value,
      borderNone: borderNoneCheckbox.checked, // Save new borderNone state
      fillColor: fillColorInput.value,
      width: widthInput.value,
      fillNone: fillNoneCheckbox.checked,
      transparency: transparencyInput.value / 100, // Store as 0-1 float
    };
    localStorage.setItem(`overlay_style_${layer.name}`, JSON.stringify(style));
    modal.classList.add("modal-hidden");
    // Reload layer if it's active. The input's ID is specifically for overlay layers.
    const input = document.getElementById(`overlay-${CSS.escape(layer.name)}`);
    if (input && input.checked) {
      await toggleOverlayLayer(layer, false); // Deactivate
      await toggleOverlayLayer(layer, true);  // Reactivate to apply new style
    }
  };

  document.getElementById("closeOverlayStyle").onclick = () => modal.classList.add("modal-hidden");
  modal.classList.remove("modal-hidden");
}

function setupEvents() {
  viewer.selectedEntityChanged.addEventListener((entity) => {
    // Prevent infoBox for file overlay entities
    if (entity && entity.dataSource) {
      for (const [overlayName, dataSource] of activeOverlays.entries()) {
        // Check if the current overlay is a DataSource (file overlay) and matches the entity's dataSource
        if (dataSource.entities && dataSource === entity.dataSource) {
          // Find the corresponding layer configuration to confirm it's a 'file' type
          const layerConfig = appConfig.overlay_layers.find(l => l.name === overlayName && l.type === 'file');
          if (layerConfig) {
            viewer.selectedEntity = undefined; // Deselect to prevent infoBox
            return; // Stop further processing for this selection
          }
        }
      }
    }

    // REDIRECT SELECTION: If we clicked on a course arrow or trail, select the main entity instead
    if (
      entity &&
      entity.id &&
      (entity.id.endsWith("-course") || entity.id.endsWith("-trail"))
    ) {
      const parentId = entity.id.replace("-course", "").replace("-trail", "");
      const parentEntity = viewer.entities.getById(parentId);
      if (parentEntity) {
        viewer.selectedEntity = parentEntity;
        return; // The event will fire again for the parent
      }
    }

    updateEntitySelectionVisibility(entity);

    const infoBox = document.querySelector(".cesium-infoBox");
    if (infoBox) {
      infoBox.classList.remove("emergency-active");
    }

    // Refresh all visibility states (labels, trails, course arrows) on selection change
    applyFilter();

    if (entity && entity.id) {
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
    const pitch = viewer.camera.pitch;
    // -PI/2 is straight down. If pitch is greater than -PI/2 + epsilon, we are tilted.
    const isTilted = pitch > -Math.PI / 2 + 0.1;
    setCameraTilt(isTilted);

    // Update filters to refresh visibility (including zoom-dependent labels)
    applyFilter();
  };
  viewer.camera.changed.addEventListener(updateZoom);
  updateZoom();

  document.getElementById("filterInput").addEventListener("input", (e) => {
    setFilters(e.target.value, undefined);
    saveAppState();
  });
  document
    .getElementById("affiliationFilter")
    .addEventListener("change", (e) => {
      setFilters(undefined, e.target.value, undefined);
      saveAppState();
    });
  document
    .getElementById("dimensionFilter")
    .addEventListener("change", (e) => {
      setFilters(undefined, undefined, e.target.value);
      saveAppState();
    });
  document.getElementById("clearFilter").addEventListener("click", () => {
    document.getElementById("filterInput").value = "";
    document.getElementById("affiliationFilter").value = "all";
    const dimFilter = document.getElementById("dimensionFilter");
    if (dimFilter) dimFilter.value = "all";
    setFilters("", "all", "all");
    saveAppState();
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

  document.getElementById("sidebarToggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
    // No need to call throttledUpdateUnitList here as the list is always visible in sidebar
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
      layerPickerPanel &&
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
