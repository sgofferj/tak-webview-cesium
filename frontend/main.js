import {
  Viewer,
  Cartesian2,
  Cartesian3,
  Color,
  VerticalOrigin,
  HorizontalOrigin,
  Ion,
  WebMapServiceImageryProvider,
  ProviderViewModel,
  OpenStreetMapImageryProvider,
  LabelStyle,
  DistanceDisplayCondition,
  CallbackProperty,
  PolylineGlowMaterialProperty,
  ColorMaterialProperty,
  HeadingPitchRange,
  Math as CesiumMath,
  Ellipsoid,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import ms from "milsymbol";
import { cotToSidc, renderGoogleIcon } from "./utils.js";

// --- GLOBAL CONFIG & TRANSLATIONS ---
let i18n = {};
let appConfig = { center_alert: false };

const affilMap = (i18n) => ({
  f: i18n.affiliationFriendly,
  a: i18n.affiliationFriendly,
  h: i18n.affiliationHostile,
  s: i18n.affiliationHostile,
  j: i18n.affiliationHostile,
  k: i18n.affiliationHostile,
  n: i18n.affiliationNeutral,
  u: i18n.affiliationUnknown,
  p: i18n.affiliationUnknown,
  o: i18n.affiliationUnknown,
});

function getAffiliationColor(type) {
  const et = type.split("-");
  const affil = et[1] ? et[1].toLowerCase() : "u";
  switch (affil) {
    case "f":
    case "a":
      return Color.CYAN;
    case "h":
    case "s":
    case "j":
    case "k":
      return Color.RED;
    case "n":
      return Color.GREEN;
    default:
      return Color.YELLOW;
  }
}

function getSquawkLabel(squawk, i18n) {
  if (!squawk) return null;
  const s = squawk.toString();
  if (s === "7500") return i18n.squawk7500 || "HIJACK";
  if (s === "7600") return i18n.squawk7600 || "RADIO FAILURE";
  if (s === "7700") return i18n.squawk7700 || "EMERGENCY";
  return null;
}

async function loadConfig() {
  try {
    const response = await fetch("/config");
    if (response.ok) {
      appConfig = await response.json();
      console.log("App Config Loaded:", appConfig);
      // Initialize iconsets from config if available
      window.availableIconsets = appConfig.iconsets || {};
    }
  } catch (e) {
    console.warn("Failed to load server config, using defaults.");
  }
}

async function loadTranslations() {
  const lang = (navigator.language || navigator.userLanguage).split("-")[0];
  const fetchLang = async (l) => {
    const response = await fetch(`/locales/${l}.json`);
    if (!response.ok) throw new Error(`Lang ${l} not found`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid JSON in ${l}.json: ${text.substring(0, 50)}`);
    }
  };

  try {
    i18n = await fetchLang(lang);
  } catch (e) {
    console.warn(`${e.message}, falling back to English.`);
    try {
      i18n = await fetchLang("en");
    } catch (e2) {
      console.error("Critical: English translation also failed.", e2);
      i18n = {
        title: "TAK Cesium Map",
        filterPlaceholder: "Filter...",
        terrainLabel: "Terrain",
      };
    }
  }
  applyStaticTranslations();
}

function applyStaticTranslations() {
  document.title = i18n.title;
  document.getElementById("filterInput").placeholder = i18n.filterPlaceholder;
  document.getElementById("clearFilter").innerText = i18n.clearButton;
  document.getElementById("resetView").innerText = i18n.resetViewButton;
  document.getElementById("resetView").title = i18n.resetViewTitle;
  document.getElementById("toggleTrails").innerText = i18n.trailsButtonOff;
  document.getElementById("toggleTrails").title = i18n.trailsTitle;
  document.getElementById("toggleUnitList").innerText = i18n.unitsButton;
  document.getElementById("toggleUnitList").title = i18n.unitsTitle;
  document.getElementById("unitListHeader").innerText = i18n.activeUnitsHeader;
  document.getElementById("toggleTerrain").innerText =
    i18n.terrainLabel || "Terrain";
  document.getElementById("toggleTerrain").title =
    i18n.terrainLabel || "Terrain";

  const affilSelect = document.getElementById("affiliationFilter");
  affilSelect.options[0].text = i18n.allAffiliations;
  affilSelect.options[1].text = i18n.affiliationFriendly;
  affilSelect.options[2].text = i18n.affiliationHostile;
  affilSelect.options[3].text = i18n.affiliationNeutral;
  affilSelect.options[4].text = i18n.affiliationUnknown;
}

// --- VIEWER SETUP ---

function calculateVisibility(data) {
  const filter = currentFilter.trim();

  // Affiliation Check
  let showByAffil = true;
  if (currentAffiliationFilter !== "all") {
    const et = data.type.split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    let simpleAffil = "u";
    if (["f", "a"].includes(affilCode)) simpleAffil = "f";
    else if (["h", "s", "j", "k"].includes(affilCode)) simpleAffil = "h";
    else if (affilCode === "n") simpleAffil = "n";

    showByAffil = simpleAffil === currentAffiliationFilter;
  }

  // Text Check
  let showByText = true;
  if (filter) {
    const searchableText = [data.uid, data.callsign, data.remarks || ""]
      .join(" ")
      .toLowerCase();
    showByText = searchableText.includes(filter);
  }

  return showByAffil && showByText;
}

const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ionToken) {
  Ion.defaultAccessToken = ionToken;
}

const finnishLayers = [
  {
    name: "Finnish Background",
    url: "https://tiles.kartat.kapsi.fi/taustakartta?",
    layers: "taustakartta",
    icon: "https://tiles.kartat.kapsi.fi/taustakartta?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=taustakartta&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
  },
  {
    name: "Finnish Topo",
    url: "https://tiles.kartat.kapsi.fi/peruskartta?",
    layers: "peruskartta",
    icon: "https://tiles.kartat.kapsi.fi/peruskartta?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=peruskartta&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
  },
  {
    name: "Finnish Aerial",
    url: "https://tiles.kartat.kapsi.fi/ortokuva?",
    layers: "ortokuva",
    icon: "https://tiles.kartat.kapsi.fi/ortokuva?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=ortokuva&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
  },
];

let viewer;

async function init() {
  await loadConfig();
  await loadTranslations();

  const imageryViewModels = [];
  if (!ionToken) {
    imageryViewModels.push(
      new ProviderViewModel({
        name: "OpenStreetMap",
        iconUrl: "https://a.tile.openstreetmap.org/0/0/0.png",
        tooltip: "OpenStreetMap",
        category: "Other",
        creationFunction: function () {
          return new OpenStreetMapImageryProvider({
            url: "https://a.tile.openstreetmap.org/",
          });
        },
      }),
    );
  }
  finnishLayers.forEach((layer) => {
    imageryViewModels.push(
      new ProviderViewModel({
        name: layer.name,
        iconUrl: layer.icon,
        tooltip: layer.name,
        category: "Finland",
        creationFunction: function () {
          return new WebMapServiceImageryProvider({
            url: layer.url,
            layers: layer.layers,
            parameters: { transparent: "true", format: "image/png" },
          });
        },
      }),
    );
  });

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
    terrainProviderViewModels: [],
    terrainExaggeration: appConfig.terrain_exaggeration || 1.0,
    terrainExaggerationRelativeHeight: 0.0,
  });
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(24.9384, 60.1699, 2000000.0),
  });

  setupEvents();
  startWebSocket();
}

// --- STATE & GLOBAL LOGIC ---

const entityState = {};
let currentFilter = "";
let currentAffiliationFilter = "all";
let showAllTrails = false;
const collapsedStates = new Set(["incidents", "aircraft", "vessels", "other"]);

function createDescription(data) {
  const { uid, callsign, remarks, link_url, emergency } = data;
  let html = `<div style="font-family: sans-serif; color: white;">`;
  if (emergency && emergency.status === "active") {
    html += `<div style="background: red; color: white; padding: 5px; text-align: center; font-weight: bold; margin-bottom: 10px;">${i18n.emergencyBanner.replace("{type}", emergency.type)}</div>`;
  }
  html += `<b>${i18n.callsignLabel}:</b> ${callsign}<br/><b>${i18n.uidLabel}:</b> ${uid}<br/>`;
  if (data.squawk) {
    const label = getSquawkLabel(data.squawk, i18n);
    if (label) {
      html += `<b>${i18n.emergencyLabel || "Emergency"}:</b> <span style="color: red; font-weight: bold;">${label}</span><br/>`;
    }
  }
  let processedRemarks = remarks || "";
  let extractedLink = link_url;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const matches = processedRemarks.match(urlRegex);
  if (matches && matches.length > 0) {
    if (!extractedLink) extractedLink = matches[0];
    processedRemarks = processedRemarks.replace(urlRegex, "");
  }
  if (processedRemarks.trim()) {
    const formattedRemarks = processedRemarks
      .replace(
        /#(\w+)/g,
        '<a class="hashtag-link" data-tag="#$1" style="color: #4af; cursor: pointer; text-decoration: underline;">#$1</a>',
      )
      .replace(/\n\s*\n/g, "\n")
      .trim()
      .replace(/\n/g, "<br/>");
    html += `<br/><b>${i18n.infoBoxHeader}:</b><br/>${formattedRemarks}<br/>`;
  }
  if (extractedLink) {
    let linkLabel = i18n.viewEvent;
    const uidLower = uid.toLowerCase();
    const remarksLower = (remarks || "").toLowerCase();
    if (uidLower.includes("gdacs")) linkLabel = i18n.viewOnGdacs;
    else if (uidLower.includes("ais") || remarksLower.includes("#ais"))
      linkLabel = i18n.viewVesselDetails;
    else if (uidLower.includes("icao") || remarksLower.includes("#adsb"))
      linkLabel = i18n.viewAircraftDetails;
    html += `<br/><b>${i18n.eventLinkLabel}:</b><br/><a href="${extractedLink}" target="_blank" style="color: #4af; text-decoration: underline;">${linkLabel}</a><br/>`;
  }
  html += `</div>`;
  return html;
}

window.filterByTag = function (tag) {
  const filterInput = document.getElementById("filterInput");
  if (filterInput) {
    filterInput.value = tag;
    currentFilter = tag.toLowerCase();
    applyFilter();
  }
};

function setupEvents() {
  viewer.selectedEntityChanged.addEventListener((entity) => {
    const infoBox = document.querySelector(".cesium-infoBox");
    if (infoBox) {
      infoBox.classList.remove("emergency-active");
    }
    Object.keys(entityState).forEach((uid) => {
      const state = entityState[uid];
      const isSelected = entity && entity.id === uid;
      if (state.trailEntity) {
        state.trailEntity.show = showAllTrails || isSelected;
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
          // Ensure the infoBox content is scrollable and styled correctly
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
    currentFilter = e.target.value.toLowerCase();
    applyFilter();
  });
  document
    .getElementById("affiliationFilter")
    .addEventListener("change", (e) => {
      currentAffiliationFilter = e.target.value;
      applyFilter();
    });
  document.getElementById("clearFilter").addEventListener("click", () => {
    document.getElementById("filterInput").value = "";
    document.getElementById("affiliationFilter").value = "all";
    currentFilter = "";
    currentAffiliationFilter = "all";
    applyFilter();
  });
  document.getElementById("resetView").addEventListener("click", () => {
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
    showAllTrails = !showAllTrails;
    e.target.innerText = showAllTrails
      ? i18n.trailsButtonOn
      : i18n.trailsButtonOff;
    const selected = viewer.selectedEntity;
    Object.keys(entityState).forEach((uid) => {
      const state = entityState[uid];
      if (state.trailEntity) {
        state.trailEntity.show =
          showAllTrails || (selected && selected.id === uid);
      }
    });
  });

  if (appConfig.terrain_url) {
    const terrainBtn = document.getElementById("toggleTerrain");
    terrainBtn.classList.remove("hidden");
    let terrainActive = false;
    terrainBtn.addEventListener("click", async () => {
      terrainActive = !terrainActive;
      if (terrainActive) {
        try {
          viewer.terrainProvider = await CesiumTerrainProvider.fromUrl(
            appConfig.terrain_url,
          );
          viewer.scene.terrainExaggeration =
            appConfig.terrain_exaggeration || 1.0;
          terrainBtn.style.background = "#666";
        } catch (e) {
          console.error("Failed to load terrain:", e);
          terrainActive = false;
        }
      } else {
        viewer.terrainProvider = new EllipsoidTerrainProvider();
        terrainBtn.style.background = "#444";
      }
    });
  }

  document.getElementById("toggleUnitList").addEventListener("click", () => {
    document.getElementById("unitListPanel").classList.toggle("hidden");
    updateUnitListUI();
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

function applyFilter() {
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    state.entity.show = calculateVisibility(state.lastData);
  });
  updateUnitListUI();
}

window.toggleCollapse = function (key) {
  if (collapsedStates.has(key)) {
    collapsedStates.delete(key);
  } else {
    collapsedStates.add(key);
  }
  updateUnitListUI();
};

function updateUnitListUI() {
  const content = document.getElementById("unitListContent");
  if (
    !content ||
    document.getElementById("unitListPanel").classList.contains("hidden")
  )
    return;

  const categories = {
    incidents: { label: i18n.categoryIncidents, groups: {} },
    aircraft: { label: i18n.categoryAircraft, groups: {} },
    vessels: { label: i18n.categoryVessels, groups: {} },
    other: { label: i18n.categoryOther, groups: {} },
  };
  const currentAffilMap = affilMap(i18n);

  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state.entity.show) return;
    const data = state.lastData;
    const uidLower = uid.toLowerCase();
    const remarksLower = (data.remarks || "").toLowerCase();

    let cat = "other";
    if (uidLower.includes("gdacs")) cat = "incidents";
    else if (uidLower.includes("icao") || remarksLower.includes("#adsb"))
      cat = "aircraft";
    else if (uidLower.includes("ais") || remarksLower.includes("#ais"))
      cat = "vessels";

    const et = data.type.split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    const affilLabel = currentAffilMap[affilCode] || i18n.affiliationUnknown;

    if (!categories[cat].groups[affilLabel]) {
      categories[cat].groups[affilLabel] = [];
    }
    categories[cat].groups[affilLabel].push({
      uid: uid,
      callsign: data.callsign,
      emergency: data.emergency && data.emergency.status === "active",
      color: state.lastRgbColor || "white",
      iconUrl: state.lastIconUrl || "",
    });
  });

  let html = "";
  Object.keys(categories).forEach((catKey) => {
    const cat = categories[catKey];
    const affilLabels = Object.keys(cat.groups);
    if (affilLabels.length === 0) return;
    const totalCount = affilLabels.reduce(
      (sum, key) => sum + cat.groups[key].length,
      0,
    );
    const catCollapsed = collapsedStates.has(catKey);

    html += `<div class="unit-group ${catCollapsed ? "collapsed" : ""}">
            <div class="unit-group-header" onclick="toggleCollapse('${catKey}')">${cat.label} (${totalCount})</div>
            <div class="unit-group-content">`;

    const priority = [
      i18n.affiliationFriendly,
      i18n.affiliationHostile,
      i18n.affiliationNeutral,
      i18n.affiliationUnknown,
    ];
    priority.forEach((affil) => {
      const units = cat.groups[affil];
      if (!units || units.length === 0) return;
      const subKey = `${catKey}-${affil}`;
      const isSubCollapsed = collapsedStates.has(subKey);

      html += `<div class="affiliation-group ${isSubCollapsed ? "collapsed" : ""}">
                <div class="affiliation-header" onclick="toggleCollapse('${subKey}')">${affil} (${units.length})</div>
                <div class="affiliation-content">`;

      units
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .forEach((unit) => {
          html += `<div class="unit-item" onclick="zoomToUnit('${unit.uid}')">
                    <img class="unit-icon" src="${unit.iconUrl}" />
                    <span class="unit-name" style="color: ${unit.color}">${unit.callsign}</span>
                    ${unit.emergency ? `<span class="unit-emergency">${i18n.emergency911Badge}</span>` : ""}
                </div>`;
        });
      html += `</div></div>`;
    });
    html += `</div></div>`;
  });
  content.innerHTML =
    html ||
    `<div style="text-align:center; padding:20px; color:#888;">${i18n.noActiveUnits}</div>`;
}

window.zoomToUnit = function (uid) {
  const state = entityState[uid];
  if (state) {
    viewer.selectedEntity = state.entity;
    viewer.flyTo(state.entity, {
      offset: new HeadingPitchRange(0, -Math.PI / 2, 200000),
    });
  }
};

// --- DATA PROCESSING ---

function updateEntity(data) {
  const {
    uid,
    callsign,
    type,
    lat,
    lon,
    alt,
    color,
    iconsetpath,
    emergency,
    course,
    squawk,
    stale,
  } = data;
  const upperType = (type || "").toUpperCase();
  let sidc = cotToSidc(upperType);
  let customIconName = null;
  let iconsetUrl = null;

  // Handle custom iconsets from the backend
  if (iconsetpath) {
    // Check if iconsetpath is a known UID
    // Format is often "uid/path/to/icon.png" or just "uid"
    // Filter out empty parts in case of leading/trailing slashes
    const parts = iconsetpath.split("/").filter((p) => p.length > 0);
    const setUid = parts.shift();
    const iconFile = parts.join("/");

    if (window.availableIconsets && window.availableIconsets[setUid]) {
      const set = window.availableIconsets[setUid];
      if (iconFile) {
        // If the iconFile part contains the full path from the CoT, use it.
        // Some producers include "Public Safety Air/" in the iconFile part.
        iconsetUrl = encodeURI(`${set.url_path}/${iconFile}`);
      } else if (set.type_map && set.type_map[type]) {
        iconsetUrl = encodeURI(`${set.url_path}/${set.type_map[type]}`);
      } else if (setUid === "66f14976-4b62-4023-8edb-d8d2ebeaa336") {
        // Mapping for Public Safety Air (fallback for legacy behavior or partial matches)
        const et = type.split("-");
        const sub = et[3] || "";
        if (type.includes("EMS")) {
          iconsetUrl = `${set.url_path}/Public Safety Air/EMS_ROTOR.png`;
        } else if (type.includes("LAW")) {
          iconsetUrl = `${set.url_path}/Public Safety Air/LAW_ROTOR.png`;
        } else if (type.includes("FIRE")) {
          iconsetUrl = `${set.url_path}/Public Safety Air/FIRE_ROTOR.png`;
        } else if (sub === "C" || sub === "F") {
          iconsetUrl = `${set.url_path}/Public Safety Air/CIV_FIXED_CAP.png`;
        } else if (sub === "H") {
          iconsetUrl = `${set.url_path}/Public Safety Air/CIV_ROTOR_ISR.png`;
        }
      }
    } else {
      // Fallback: If we don't recognize the UID, but it looks like a relative path
      // that might be served under /iconsets/
      if (iconsetpath.startsWith("/")) {
        iconsetUrl = iconsetpath;
      } else {
        iconsetUrl = `/iconsets/${iconsetpath}`;
      }
    }
  }

  let rgbColor = "white";
  let cesiumColor = Color.WHITE;
  const affiliationColor = getAffiliationColor(type);

  if (color) {
    const argb = parseInt(color);
    const r = (argb >> 16) & 0xff;
    const g = (argb >> 8) & 0xff;
    const b = argb & 0xff;
    rgbColor = `rgb(${r},${g},${b})`;
    cesiumColor = Color.fromBytes(r, g, b, 255);
  }

  const effectiveColor = color ? cesiumColor : affiliationColor;

  const clampedAlt = alt > 9000000 ? 0 : alt;
  const position = Cartesian3.fromDegrees(lon, lat, clampedAlt || 0);

  // Zoom-dependent altitude display logic
  const camHeight = viewer.camera.positionCartographic.height;
  const showAltOnIcon = camHeight < 200000 && type.split("-")[2] === "A";

  const stateKey = iconsetUrl
    ? `icon-${iconsetUrl}-${rgbColor}`
    : customIconName
      ? `cust-${customIconName}-${rgbColor}`
      : `${sidc}-${color}-${showAltOnIcon ? Math.round(clampedAlt) : "noalt"}`;
  const description = createDescription(data);

  let state = entityState[uid];
  if (state) {
    state.entity.position = position;
    state.entity.description = description;

    if (appConfig.center_alert) {
      const previouslyActive =
        state.lastData &&
        state.lastData.emergency &&
        state.lastData.emergency.status === "active";
      const currentlyActive = emergency && emergency.status === "active";
      if (currentlyActive && !previouslyActive) {
        viewer.flyTo(state.entity, {
          offset: new HeadingPitchRange(0, -Math.PI / 2, 200000),
        });
        viewer.selectedEntity = state.entity;
        const infoBox = document.querySelector(".cesium-infoBox");
        if (infoBox) infoBox.classList.add("emergency-active");
      }
    }

    if (emergency && emergency.status === "cancelled") {
      const infoBox = document.querySelector(".cesium-infoBox");
      if (infoBox) infoBox.classList.remove("emergency-active");
    }

    state.lastData = data;
    state.history.push(position);
    if (state.history.length > 100) state.history.shift();

    if (state.lastStateKey !== stateKey) {
      let iconCanvas, iconAnchor, iconSize;
      if (iconsetUrl) {
        // Create an Image object to load the iconset png
        // Note: this is async, but billboard.image can take a Promise or Image
        state.entity.billboard.image = iconsetUrl;
        state.entity.billboard.width = 28;
        state.entity.billboard.height = 28;
        state.entity.billboard.pixelOffset = new Cartesian2(0, 0);
        state.lastIconUrl = iconsetUrl;
        iconCanvas = null;
      } else if (customIconName) {
        iconCanvas = renderGoogleIcon(customIconName, rgbColor, 32);
        iconAnchor = { x: 16, y: 16 };
        iconSize = { width: 32, height: 32 };
      } else {
        const isAircraft = type.split("-")[2] === "A";
        const symbolOptions = { size: 21, padding: 5 };
        const label = getSquawkLabel(squawk, i18n);
        if (label) {
          symbolOptions.staffComments = label;
        }
        if (isAircraft && course !== null && course !== undefined) {
          symbolOptions.direction = course;
        }
        if (showAltOnIcon) {
          symbolOptions.altitudeDepth = Math.round(clampedAlt).toString();
        }
        const symbol = new ms.Symbol(sidc, symbolOptions);
        iconCanvas = symbol.asCanvas();
        iconAnchor = symbol.getAnchor();
        iconSize = symbol.getSize();
      }

      if (iconCanvas) {
        state.entity.billboard.image = iconCanvas;
        state.entity.billboard.width = undefined;
        state.entity.billboard.height = undefined;
        state.entity.billboard.pixelOffset = new Cartesian2(
          iconSize.width / 2 - iconAnchor.x,
          iconSize.height / 2 - iconAnchor.y,
        );
        state.lastIconUrl = iconCanvas.toDataURL();
      }
      state.entity.billboard.color = cesiumColor;
      state.lastStateKey = stateKey;
      state.lastRgbColor = rgbColor;
    }
    state.staleAt = stale ? new Date(stale).getTime() : null;

    // Handle Squawk Codes (7500, 7600, 7700)
    const squawkLabel = getSquawkLabel(squawk, i18n);
    if (squawkLabel) {
      state.entity.label.text = `${callsign}\n[${squawkLabel}]`;
      state.entity.label.fillColor = Color.RED;
      // Add flashing circle if it doesn't exist
      if (!state.flashingCircle) {
        state.flashingCircle = viewer.entities.add({
          position: new CallbackProperty(
            () => state.entity.position.getValue(viewer.clock.currentTime),
            false,
          ),
          ellipse: {
            semiMinorAxis: 500,
            semiMajorAxis: 500,
            material: new ColorMaterialProperty(
              new CallbackProperty(() => {
                const alpha = (Math.sin(Date.now() / 200) + 1) / 2;
                return Color.RED.withAlpha(alpha * 0.5);
              }, false),
            ),
            height: new CallbackProperty(() => {
              const pos = state.entity.position.getValue(
                viewer.clock.currentTime,
              );
              if (!pos) return 0;
              return Ellipsoid.WGS84.cartesianToCartographic(pos).height;
            }, false),
          },
        });
      }
    } else {
      state.entity.label.text = callsign;
      state.entity.label.fillColor = Color.WHITE;
      if (state.flashingCircle) {
        viewer.entities.remove(state.flashingCircle);
        state.flashingCircle = null;
      }
    }

    // Handle Direction Arrow
    if (
      course !== null &&
      course !== undefined &&
      (iconsetUrl || customIconName) &&
      type.split("-")[2] === "A"
    ) {
      if (!state.directionArrow) {
        state.directionArrow = viewer.entities.add({
          position: new CallbackProperty(
            () => state.entity.position.getValue(viewer.clock.currentTime),
            false,
          ),
          polyline: {
            positions: new CallbackProperty(() => {
              const pos = state.entity.position.getValue(
                viewer.clock.currentTime,
              );
              if (!pos || course === null) return [];
              const cart = Ellipsoid.WGS84.cartesianToCartographic(pos);
              const destLon =
                cart.longitude +
                Math.sin(CesiumMath.toRadians(course)) * 0.0001;
              const destLat =
                cart.latitude + Math.cos(CesiumMath.toRadians(course)) * 0.0001;
              return [
                pos,
                Cartesian3.fromRadians(destLon, destLat, cart.height),
              ];
            }, false),
            width: 2,
            material: effectiveColor,
            disableDepthTestDistance: 200000,
          },
        });
      }
    } else {
      if (state.directionArrow) {
        viewer.entities.remove(state.directionArrow);
        state.directionArrow = null;
      }
    }
    state.entity.billboard.rotation = 0;

    state.entity.show = calculateVisibility(data);
  } else {
    const history = [position];
    const entity = viewer.entities.add({
      id: uid,
      name: callsign,
      position: position,
      viewFrom: new Cartesian3(0, 0, 200000),
      billboard: {
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        eyeOffset: new Cartesian3(0, 0, -10),
        disableDepthTestDistance: 200000,
        color: cesiumColor,
      },
      label: {
        text: callsign,
        font: "bold 14px sans-serif",
        style: LabelStyle.FILL_AND_OUTLINE,
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 4,
        showBackground: true,
        backgroundColor: new Color(0, 0, 0, 0.4),
        backgroundPadding: new Cartesian2(7, 5),
        verticalOrigin: VerticalOrigin.TOP,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, 20),
        eyeOffset: new Cartesian3(0, 0, -20),
        disableDepthTestDistance: 200000,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 200000),
      },
      description: description,
    });

    let iconCanvas, iconAnchor, iconSize;
    if (iconsetUrl) {
      entity.billboard.image = iconsetUrl;
      entity.billboard.width = 28;
      entity.billboard.height = 28;
      entity.billboard.pixelOffset = new Cartesian2(0, 0);
      iconCanvas = null;
    } else if (customIconName) {
      iconCanvas = renderGoogleIcon(customIconName, rgbColor, 32);
      iconAnchor = { x: 16, y: 16 };
      iconSize = { width: 32, height: 32 };
    } else {
      const isAircraft = type.split("-")[2] === "A";
      const symbolOptions = { size: 21, padding: 5 };
      const label = getSquawkLabel(squawk, i18n);
      if (label) {
        symbolOptions.staffComments = label;
      }
      if (isAircraft && course !== null && course !== undefined) {
        symbolOptions.direction = course;
      }
      if (showAltOnIcon) {
        symbolOptions.altitudeDepth = Math.round(clampedAlt).toString();
      }
      const symbol = new ms.Symbol(sidc, symbolOptions);
      iconCanvas = symbol.asCanvas();
      iconAnchor = symbol.getAnchor();
      iconSize = symbol.getSize();
    }

    if (iconCanvas) {
      entity.billboard.image = iconCanvas;
      entity.billboard.width = undefined;
      entity.billboard.height = undefined;
      entity.billboard.pixelOffset = new Cartesian2(
        iconSize.width / 2 - iconAnchor.x,
        iconSize.height / 2 - iconAnchor.y,
      );
    }

    const trailEntity = viewer.entities.add({
      polyline: {
        positions: new CallbackProperty(() => history, false),
        width: 4,
        material: new PolylineGlowMaterialProperty({
          glowPower: 0.25,
          taperPower: 1.0,
          color: effectiveColor,
        }),
        disableDepthTestDistance: 200000,
      },
      show: showAllTrails,
    });

    state = {
      entity: entity,
      trailEntity: trailEntity,
      history: history,
      lastStateKey: stateKey,
      lastData: data,
      lastIconUrl: iconCanvas ? iconCanvas.toDataURL() : iconsetUrl,
      lastRgbColor: rgbColor,
      staleAt: stale ? new Date(stale).getTime() : null,
    };
    entityState[uid] = state;

    const currentAffilMap = affilMap(i18n);
    const et = data.type.split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    const affilLabel = currentAffilMap[affilCode] || i18n.affiliationUnknown;
    let cat = "other";
    if (uid.toLowerCase().includes("gdacs")) cat = "incidents";
    else if (uid.toLowerCase().includes("icao")) cat = "aircraft";
    else if (uid.toLowerCase().includes("ais")) cat = "vessels";
    collapsedStates.add(`${cat}-${affilLabel}`);

    if (appConfig.center_alert && emergency && emergency.status === "active") {
      viewer.flyTo(entity, {
        offset: new HeadingPitchRange(0, -Math.PI / 2, 200000),
      });
      viewer.selectedEntity = entity;
      const infoBox = document.querySelector(".cesium-infoBox");
      if (infoBox) infoBox.classList.add("emergency-active");
    }

    entity.show = calculateVisibility(data);
  }

  if (!window._unitListUpdatePending) {
    window._unitListUpdatePending = true;
    setTimeout(() => {
      updateUnitListUI();
      window._unitListUpdatePending = false;
    }, 1000);
  }
}

function removeEntity(uid) {
  const state = entityState[uid];
  if (!state) return;

  if (state.entity) viewer.entities.remove(state.entity);
  if (state.trailEntity) viewer.entities.remove(state.trailEntity);
  if (state.flashingCircle) viewer.entities.remove(state.flashingCircle);
  if (state.directionArrow) viewer.entities.remove(state.directionArrow);

  delete entityState[uid];
  updateUnitListUI();
}

// Periodic cleanup for stale entities
setInterval(() => {
  const now = Date.now();
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (state.staleAt && now > state.staleAt) {
      console.log(`Removing stale entity: ${uid}`);
      removeEntity(uid);
    }
  });
}, 5000);

// --- WS CLIENT ---

function startWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsHost = import.meta.env.VITE_WS_HOST || window.location.host;
  const wsPath = import.meta.env.VITE_WS_PATH || "/ws";
  const wsUrl = `${protocol}//${wsHost}${wsPath}`;
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    console.log("Connected to Backend WebSocket");
  };
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      updateEntity(data);
    } catch (e) {
      console.error("Error parsing WS message", e);
    }
  };
  ws.onerror = (error) => {
    console.error("WebSocket Error", error);
  };
  ws.onclose = () => {
    console.log("WebSocket Connection Closed");
  };
}

init();
