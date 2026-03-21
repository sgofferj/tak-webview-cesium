// state.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import {
  Cartesian2,
  Cartesian3,
  Color,
  VerticalOrigin,
  HorizontalOrigin,
  LabelStyle,
  DistanceDisplayCondition,
  HeadingPitchRange,
  PolylineOutlineMaterialProperty,
  HeightReference,
  CallbackProperty,
  Math as CesiumMath,
} from "cesium";

const GROUND_OFFSET = 0; // Surface clamping
import ms from "milsymbol";
import mgrs from "mgrs";
import { i18n } from "./config.js";
import { viewer } from "./viewer.js";
import {
  cotToSidc,
  getAffiliationColor,
  getSquawkLabel,
  affilMap,
  throttle,
  renderGoogleIcon,
} from "./utils.js";

export const entityState = {};
export let currentFilter = "";
export let currentAffiliationFilter = "all";
export let unitListDirty = true;
export const collapsedStates = new Set([
  "incidents",
  "aircraft",
  "vessels",
  "other",
]);

export let previouslySelectedEntityId = null;

const MAX_DISTANCE = 100000000.0;
const HORIZON_LIMIT = 1000000.0; // 1000km
const TACTICAL_DISTANCE = 200000.0; // 200km

const ddcAlways = new DistanceDisplayCondition(0, MAX_DISTANCE);
const ddcTactical = new DistanceDisplayCondition(0, TACTICAL_DISTANCE);

const DDC_UNSELECTED_LABEL = ddcTactical;
const DDC_UNSELECTED_TRAIL = ddcTactical;

const DDC_SELECTED = ddcAlways;

const DDD_UNSELECTED = HORIZON_LIMIT;
const DDD_SELECTED = MAX_DISTANCE;

const REVERSE_KEY_MAP = {
  i: "uid",
  t: "type",
  c: "callsign",
  la: "lat",
  lo: "lon",
  al: "alt",
  s: "stale",
  r: "remarks",
  sq: "squawk",
  co: "course",
  sp: "speed",
  l: "link_url",
  cl: "color",
  ip: "iconsetpath",
  e: "emergency",
  x: "xmpp",
  m: "mail",
  p: "phone",
  b: "battery",
  h: "how",
  gr: "group_role",
  gn: "group_name",
  ce: "ce",
};

// Global icon cache to prevent redundant rendering
const iconCache = new Map();
// Reference counting for blob URLs to prevent memory leaks while avoiding broken images
const blobUsageRegistry = new Map();
// Lock to prevent duplicate entity creation during async calls
const pendingCreation = new Set();
// Track pending icon generations to prevent race conditions
const pendingIcons = new Map();

function registerBlobUsage(url) {
  if (!url || !url.startsWith("blob:")) return;
  const count = blobUsageRegistry.get(url) || 0;
  blobUsageRegistry.set(url, count + 1);
}

function unregisterBlobUsage(url) {
  if (!url || !url.startsWith("blob:")) return;
  const count = blobUsageRegistry.get(url) || 0;
  if (count <= 1) {
    blobUsageRegistry.delete(url);
    // Check if it's still in the icon cache before revoking
    let inCache = false;
    for (const cached of iconCache.values()) {
      if (cached.blobUrl === url) {
        inCache = true;
        break;
      }
    }
    if (!inCache) {
      URL.revokeObjectURL(url);
    }
  } else {
    blobUsageRegistry.set(url, count - 1);
  }
}

export function setFilters(filter, affiliation) {
  if (filter !== undefined) currentFilter = filter.toLowerCase();
  if (affiliation !== undefined) currentAffiliationFilter = affiliation;
  applyFilter();
}

export function calculateVisibility(data) {
  if (!data || !data.type) return false;
  const filter = currentFilter.trim();

  let showByAffil = true;
  if (currentAffiliationFilter !== "all") {
    const et = data.type.split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    let simpleAffil = "u";
    if (["f", "a"].includes(affilCode)) simpleAffil = "f";
    else if (affilCode === "h") simpleAffil = "h";
    else if (affilCode === "s") simpleAffil = "s";
    else if (["j", "k"].includes(affilCode)) simpleAffil = "h"; // Joker/Faker treated as hostile
    else if (affilCode === "n") simpleAffil = "n";

    showByAffil = simpleAffil === currentAffiliationFilter;
  }

  let showByText = true;
  if (filter) {
    const searchableText = [data.uid, data.callsign, data.remarks || ""]
      .join(" ")
      .toLowerCase();
    showByText = searchableText.includes(filter);
  }

  return showByAffil && showByText;
}

export function calculateTrailVisibility(uid) {
  const state = entityState[uid];
  if (!state || !state.trailEntity) return false;
  // Trail ONLY for selected entity
  const isSelected = viewer.selectedEntity && viewer.selectedEntity.id === uid;
  const isVisible = calculateVisibility(state.lastData);
  return isVisible && isSelected;
}

export function applyFilter() {
  if (!viewer) return;
  unitListDirty = true;
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state) return; // Safety check for concurrent removal

    const isSelected = viewer.selectedEntity && viewer.selectedEntity.id === uid;
    const isVisible = calculateVisibility(state.lastData);

    // Icons follow filter
    if (state.entity) {
      state.entity.show = isVisible;
      
      // Labels show when selected OR zoomed in (<200km)
      if (state.entity.label) {
        const cameraDistance = viewer.camera.positionCartographic.height;
        const showLabel = isSelected || (isVisible && cameraDistance < TACTICAL_DISTANCE);
        state.entity.label.show = showLabel;
      }
    }
    
    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
    if (state.courseEntity) {
      state.courseEntity.show = isVisible;
    }
  });
  throttledUpdateUnitList();
}

export function createDescription(data) {
  const {
    uid,
    callsign,
    remarks,
    link_url,
    emergency,
    xmpp,
    mail,
    phone,
    battery,
    lat,
    lon,
    alt,
    speed,
    course,
  } = data;
  let html = `<div style="font-family: sans-serif; color: white;">`;
  if (emergency && emergency.status === "active") {
    html += `<div style="background: red; color: white; padding: 5px; text-align: center; font-weight: bold; margin-bottom: 10px;">${i18n.emergencyBanner.replace("{type}", emergency.type)}</div>`;
  }
  html += `<b>${i18n.callsignLabel}:</b> ${callsign}<br/><b>${i18n.uidLabel}:</b> ${uid}<br/>`;

  if (lat !== undefined && lon !== undefined) {
    try {
      const mgrsStr = mgrs.forward([lon, lat]);
      html += `<b>MGRS:</b> ${mgrsStr}<br/>`;
    } catch (e) {
      console.error("MGRS failed", e);
    }
    html += `<b>Lat/Lon:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}<br/>`;
  }
  if (alt !== undefined && alt !== null)
    html += `<b>Alt:</b> ${alt.toFixed(0)} m<br/>`;
  if (speed !== undefined && speed !== null)
    html += `<b>Speed:</b> ${(speed * 3.6).toFixed(1)} km/h<br/>`;
  if (course !== undefined && course !== null)
    html += `<b>Course:</b> ${course.toFixed(0)}°<br/>`;

  if (xmpp || mail || phone) {
    html += `<br/><b>Contact information:</b><br/>`;
    if (xmpp)
      html += `<b>XMPP:</b> <a href="xmpp:${xmpp}" style="color: #4af;">${xmpp}</a><br/>`;
    if (mail)
      html += `<b>Email:</b> <a href="mailto:${mail}" style="color: #4af;">${mail}</a><br/>`;
    if (phone)
      html += `<b>Phone:</b> <a href="tel:${phone}" style="color: #4af;">${phone}</a><br/>`;
  }

  if (data.squawk) {
    const label = getSquawkLabel(data.squawk, i18n);
    if (label)
      html += `<b>${i18n.emergencyLabel || "Emergency"}:</b> <span style="color: red; font-weight: bold;">${label}</span><br/>`;
  }
  let processedRemarks = remarks || "";
  let extractedLink = link_url;
  const urlRegex = new RegExp("https?://[^\\s]+", "g");
  const matches = processedRemarks.match(urlRegex);
  if (matches && matches.length > 0) {
    if (!extractedLink) extractedLink = matches[0];
    processedRemarks = processedRemarks.replace(urlRegex, "");
  }
  if (processedRemarks.trim()) {
    const formattedRemarks = processedRemarks
      .replace(
        new RegExp("#(\\w+)", "g"),
        '<a class="hashtag-link" data-tag="#$1" style="color: #4af; cursor: pointer; text-decoration: underline;">#$1</a>',
      )
      .replace(new RegExp("\\n\\s*\\n", "g"), "\n")
      .trim()
      .replace(new RegExp("\\n", "g"), "<br/>");
    html += `<br/><b>${i18n.infoBoxHeader}:</b><br/>${formattedRemarks}<br/>`;
  }
  if (extractedLink) {
    let linkLabel = i18n.viewEvent;
    const uidLower = uid.toLowerCase();
    if (uidLower.includes("gdacs")) linkLabel = i18n.viewOnGdacs;
    else if (uidLower.includes("ais")) linkLabel = i18n.viewVesselDetails;
    else if (uidLower.includes("icao")) linkLabel = i18n.viewAircraftDetails;
    html += `<br/><b>${i18n.eventLinkLabel}:</b><br/><a href="${extractedLink}" target="_blank" style="color: #4af; text-decoration: underline;">${linkLabel}</a><br/>`;
  }

  if (battery !== undefined && battery !== null) {
    let battColor = "#4caf50";
    if (battery < 20) battColor = "#f44336";
    else if (battery < 50) battColor = "#ff9800";
    html += `
      <div style="margin-top: 15px; display: flex; align-items: center; gap: 8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M16,20H8V6H16V20M16.67,4H15V2H9V4H7.33A0.67,0.67 0 0,0 6.67,4.67V20.33A0.67,0.67 0 0,0 7.33,21H16.67A0.67,0.67 0 0,0 17.33,20.33V4.67A0.67,0.67 0 0,0 16.67,4Z" /></svg>
        <div style="flex-grow: 1; height: 14px; background: #333; border-radius: 7px; border: 1px solid #555; position: relative; overflow: hidden;">
          <div style="width: ${battery}%; height: 100%; background: ${battColor}; transition: width 0.3s ease;"></div>
          <div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: bold; color: white; text-shadow: 1px 1px 2px black;">${battery}%</div>
        </div>
      </div>`;
  }
  html += `</div>`;
  return html;
}

export function updateUnitListUI() {
  if (!unitListDirty) return;
  const content = document.getElementById("unitListContent");
  const panel = document.getElementById("unitListPanel");
  if (!content || !panel || panel.classList.contains("hidden")) return;

  const categories = {
    incidents: { label: i18n.categoryIncidents, groups: {} },
    aircraft: { label: i18n.categoryAircraft, groups: {} },
    vessels: { label: i18n.categoryVessels, groups: {} },
    other: { label: i18n.categoryOther, groups: {} },
  };
  const currentAffilMap = affilMap(i18n);

  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state || !state.entity || !state.entity.show) return;
    const data = state.lastData;
    const uidLower = uid.toLowerCase();
    let cat = "other";
    if (uidLower.includes("gdacs")) cat = "incidents";
    else if (
      uidLower.includes("icao") ||
      (data.remarks || "").toLowerCase().includes("#adsb")
    )
      cat = "aircraft";
    else if (
      uidLower.includes("ais") ||
      (data.remarks || "").toLowerCase().includes("#ais")
    )
      cat = "vessels";

    const et = (data.type || "u-u-g").split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    const affilLabel = currentAffilMap[affilCode] || i18n.affiliationUnknown;

    if (!categories[cat].groups[affilLabel])
      categories[cat].groups[affilLabel] = [];
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
    if (Object.keys(cat.groups).length === 0) return;
    const totalCount = Object.values(cat.groups).reduce(
      (sum, g) => sum + g.length,
      0,
    );
    const catCollapsed = collapsedStates.has(catKey);
    html += `<div class="unit-group ${catCollapsed ? "collapsed" : ""}" id="group-${catKey}">
            <div class="unit-group-header" onclick="toggleCollapse('${catKey}')">${cat.label} (${totalCount})</div>
            <div class="unit-group-content">`;
    [
      i18n.affiliationFriendly,
      i18n.affiliationHostile,
      i18n.affiliationSuspect,
      i18n.affiliationNeutral,
      i18n.affiliationUnknown,
    ].forEach((affil) => {
      const units = cat.groups[affil];
      if (!units || units.length === 0) return;
      const subKey = `${catKey}-${affil}`;
      const isSubCollapsed = collapsedStates.has(subKey);
      html += `<div class="affiliation-group ${isSubCollapsed ? "collapsed" : ""}" id="group-${subKey}">
                <div class="affiliation-header" onclick="toggleCollapse('${subKey}')">${affil} (${units.length})</div>
                <div class="affiliation-content">`;
      units
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .forEach((unit) => {
          html += `<div class="unit-item" id="unit-${unit.uid}" onclick="zoomToUnit('${unit.uid}')">
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
  unitListDirty = false;
}

export const throttledUpdateUnitList = throttle(updateUnitListUI, 1000);

window.toggleCollapse = function (key) {
  if (collapsedStates.has(key)) collapsedStates.delete(key);
  else collapsedStates.add(key);
  unitListDirty = true;
  updateUnitListUI();
};

window.zoomToUnit = function (uid) {
  const state = entityState[uid];
  if (state && viewer) {
    viewer.selectedEntity = state.entity;
    viewer.flyTo(state.entity, {
      offset: new HeadingPitchRange(0, -Math.PI / 2, 100000),
    });
  }
};

function drawGroupIcon(name, role, how) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const cx = 128;
  const cy = 128;

  const groupColors = {
    Cyan: "#00FFFF",
    Green: "#00FF00",
    Blue: "#0000FF",
    Red: "#FF0000",
    Yellow: "#FFFF00",
    Magenta: "#FF00FF",
    White: "#FFFFFF",
    Maroon: "#800000",
    "Dark Blue": "#00008B",
    "Dark Green": "#006400",
    Purple: "#800080",
    Orange: "#FFA500",
    Brown: "#A52A2A",
  };
  const roleAbbrMap = {
    "Team Member": "none",
    "Team Lead": "TL",
    HQ: "HQ",
    Sniper: "S",
    Medic: "M",
    "Forward Observer": "FO",
    RTO: "R",
    K9: "K9",
  };
  const fillColor = groupColors[name] || name || "#FFFFFF";
  const rawAbbr =
    roleAbbrMap[role] || (role ? role.substring(0, 3).toUpperCase() : "");
  const abbr = rawAbbr === "none" ? "" : rawAbbr;

  ctx.beginPath();
  ctx.arc(cx, cy, 96, 0, 2 * Math.PI);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "black";
  ctx.stroke();

  if (how !== "m-g") {
    ctx.beginPath();
    ctx.moveTo(cx - 68, cy + 68);
    ctx.lineTo(cx + 68, cy - 68);
    ctx.lineWidth = 16;
    ctx.strokeStyle = "black";
    ctx.stroke();
  }

  if (abbr) {
    ctx.font = "bold 72px sans-serif";
    const textMetrics = ctx.measureText(abbr);
    ctx.fillStyle = fillColor;
    ctx.fillRect(
      cx - textMetrics.width / 2 - 8,
      cy - 44,
      textMetrics.width + 16,
      88,
    );
    ctx.fillStyle = "black";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(abbr, cx, cy);
  }

  return canvas;
}

async function canvasToBlobUrl(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

export async function updateEntity(incomingData) {
  if (!viewer || !viewer.entities) return;

  const data = {};
  for (const key in incomingData) {
    data[REVERSE_KEY_MAP[key] || key] = incomingData[key];
  }
  const { uid } = data;
  if (!uid) return;

  let state = entityState[uid];
  if (!state && pendingCreation.has(uid)) return;

  if (state) {
    data.uid = uid;
    for (const k in data) {
      if (data[k] !== undefined) state.lastData[k] = data[k];
    }
  } else if (!data.type) return;

  const fullData = state ? state.lastData : data;
  const {
    callsign,
    type,
    lat,
    lon,
    alt,
    color,
    iconsetpath,
    stale,
    how,
    group_role,
    group_name,
    squawk,
    course,
  } = fullData;

  const typeParts = (type || "").toLowerCase().split("-");
  const isAir = typeParts[0] === "a" && typeParts[2] === "a";
  const iconHeight =
    isAir && alt !== undefined && alt < 9000000 ? alt : GROUND_OFFSET;
  const iconRef = isAir
    ? HeightReference.NONE
    : HeightReference.CLAMP_TO_GROUND;
  const position = Cartesian3.fromDegrees(lon, lat, iconHeight);
  const anchorPosition = Cartesian3.fromDegrees(lon, lat, 0);

  const sidc = cotToSidc((type || "").toUpperCase());

  let iconsetUrl = null;
  if (iconsetpath) {
    const parts = iconsetpath.split("/").filter((p) => p.length > 0);
    const setUid = parts.shift();
    const iconFile = parts.join("/");
    if (window.availableIconsets && window.availableIconsets[setUid]) {
      const set = window.availableIconsets[setUid];
      if (iconFile) iconsetUrl = encodeURI(`${set.url_path}/${iconFile}`);
      else if (set.type_map && set.type_map[type])
        iconsetUrl = encodeURI(`${set.url_path}/${set.type_map[type]}`);
    } else
      iconsetUrl = iconsetpath.startsWith("/")
        ? iconsetpath
        : `/iconsets/${iconsetpath}`;
  }

  let rgbColor = "white",
    cesiumColor = Color.WHITE;
  if (color) {
    const argb = parseInt(color);
    const r = (argb >> 16) & 0xff,
      g = (argb >> 8) & 0xff,
      b = argb & 0xff;
    rgbColor = `rgb(${r},${g},${b})`;
    cesiumColor = Color.fromBytes(r, g, b, 255);
  }
  const effectiveColor = color ? cesiumColor : getAffiliationColor(type);
  const useTeamCircle = !!group_name && !!group_role;

  const stateKey = useTeamCircle
    ? `group-${group_name}-${group_role}-${color}-${how}`
    : iconsetUrl
      ? `icon-${iconsetUrl}-${rgbColor}`
      : `${sidc}-${color}-${squawk}`;

  const description = createDescription(fullData);

  if (!state) {
    pendingCreation.add(uid);
    try {
      const history = [anchorPosition, anchorPosition];
      const entity = viewer.entities.add({
        id: uid,
        name: callsign,
        position: position,
        billboard: {
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          eyeOffset: new Cartesian3(0, 0, -10),
          distanceDisplayCondition: ddcAlways,
          disableDepthTestDistance: HORIZON_LIMIT,
          heightReference: iconRef,
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
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER,
          pixelOffset: new Cartesian2(0, -25),
          eyeOffset: new Cartesian3(0, 0, -20),
          distanceDisplayCondition: DDC_UNSELECTED_LABEL,
          disableDepthTestDistance: DDD_UNSELECTED,
          heightReference: iconRef,
        },
        description: description,
      });

      const trailEntity = viewer.entities.add({
        id: uid + "-trail",
        polyline: {
          positions: history,
          width: 3,
          material: new PolylineOutlineMaterialProperty({
            color: effectiveColor,
            outlineWidth: 2,
            outlineColor: Color.BLACK.withAlpha(0.5),
          }),
          distanceDisplayCondition: DDC_UNSELECTED_TRAIL,
          disableDepthTestDistance: HORIZON_LIMIT,
          clampToGround: true,
        },
        show: false,
      });

      const courseEntity = viewer.entities.add({
        id: uid + "-course",
        billboard: {
          image: renderGoogleIcon("triangle", "white", 24, true, true),
          width: 16,
          height: 16,
          horizontalOrigin: HorizontalOrigin.CENTER,
          verticalOrigin: VerticalOrigin.CENTER,
          eyeOffset: new Cartesian3(0, 0, -15),
          disableDepthTestDistance: HORIZON_LIMIT,
          heightReference: iconRef,
        },
        show: true,
      });

      state = {
        entity,
        trailEntity,
        courseEntity,
        history,
        lastStateKey: "",
        lastData: fullData,
        lastIconUrl: "",
        lastPosition: position,
      };
      entityState[uid] = state;
      unitListDirty = true;
    } finally {
      pendingCreation.delete(uid);
    }
  } else {
    if (!position.equals(state.lastPosition)) {
      state.entity.position = position;
      state.lastPosition = position;
    }
    state.entity.description = description;

    if (state.entity.billboard.heightReference !== iconRef) {
      state.entity.billboard.heightReference = iconRef;
      state.entity.label.heightReference = iconRef;
    }

    state.history.push(anchorPosition);
    if (state.history.length > 100) state.history.shift();

    if (
      viewer.clock &&
      state.entity.label &&
      state.entity.label.text &&
      state.entity.label.text.getValue(viewer.clock.currentTime) !== callsign
    ) {
      state.entity.label.text = callsign;
      unitListDirty = true;
    }

    const trailVisible = calculateVisibility(fullData) && viewer.selectedEntity && viewer.selectedEntity.id === uid;
    state.trailEntity.show = trailVisible;
    if (trailVisible) {
      state.trailEntity.polyline.positions = [...state.history];
    }
  }

  // Update Course Vector
  const hasCourse = course !== undefined && course !== null;
  if (hasCourse) {
    state.courseEntity.position = position;
    // Dynamic leading arrow: always ahead of icon regardless of camera rotation
    if (
      !state.courseEntity.billboard.rotation ||
      typeof state.courseEntity.billboard.rotation.getValue !== "function"
    ) {
      state.courseEntity.billboard.rotation = new CallbackProperty(() => {
        const s = entityState[uid];
        if (!s || !s.lastData || s.lastData.course === undefined) return 0;
        return -CesiumMath.toRadians(s.lastData.course) + viewer.camera.heading;
      }, false);
    }
    if (
      !state.courseEntity.billboard.pixelOffset ||
      typeof state.courseEntity.billboard.pixelOffset.getValue !== "function"
    ) {
      state.courseEntity.billboard.pixelOffset = new CallbackProperty(() => {
        const s = entityState[uid];
        if (!s || !s.lastData || s.lastData.course === undefined)
          return new Cartesian2(0, 0);
        const angle =
          CesiumMath.toRadians(s.lastData.course) - viewer.camera.heading;
        const dist = 22; // Pixels from center
        return new Cartesian2(Math.sin(angle) * dist, -Math.cos(angle) * dist);
      }, false);
    }
    state.courseEntity.billboard.heightReference = iconRef;
    state.courseEntity.show = true;
  } else if (state && state.courseEntity) {
    state.courseEntity.show = false;
  }

  if (state.lastStateKey !== stateKey) {
    let iconUrl, pixelOffset, width, height, billboardColor;

    if (iconCache.has(stateKey)) {
      const cached = iconCache.get(stateKey);
      iconUrl = cached.blobUrl;
      width = cached.width;
      height = cached.height;
      pixelOffset = cached.pixelOffset || new Cartesian2(0, 0);
      billboardColor = cached.color || Color.WHITE;
    } else if (pendingIcons.has(stateKey)) {
      // If someone else is already making this icon, wait for them
      const result = await pendingIcons.get(stateKey);
      iconUrl = result.blobUrl;
      width = result.width;
      height = result.height;
      pixelOffset = result.pixelOffset;
      billboardColor = result.color;
    } else {
      // We are the ones making the icon
      const generateIcon = async () => {
        let iUrl,
          pOff = new Cartesian2(0, 0),
          w = 28,
          h = 28,
          bCol = Color.WHITE;

        if (useTeamCircle) {
          const canvas = drawGroupIcon(group_name, group_role, how);
          iUrl = await canvasToBlobUrl(canvas);
          w = 32;
          h = 32;
        } else if (iconsetUrl) {
          iUrl = iconsetUrl;
          bCol = color ? cesiumColor : Color.WHITE;
        } else {
          const symbolOptions = { size: 21, padding: 10 };
          const symbol = new ms.Symbol(sidc, symbolOptions);
          const canvas = symbol.asCanvas();
          const iconAnchor = symbol.getAnchor();
          const iconSize = symbol.getSize();
          iUrl = await canvasToBlobUrl(canvas);
          const scale = 1.1;
          w = iconSize.width * scale;
          h = iconSize.height * scale;
          pOff = new Cartesian2(
            (iconSize.width / 2 - iconAnchor.x) * scale,
            (iconSize.height / 2 - iconAnchor.y) * scale,
          );
        }
        const cacheEntry = {
          blobUrl: iUrl,
          pixelOffset: pOff,
          width: w,
          height: h,
          color: bCol,
        };
        iconCache.set(stateKey, cacheEntry);
        return cacheEntry;
      };

      const pendingPromise = generateIcon();
      pendingIcons.set(stateKey, pendingPromise);
      const result = await pendingPromise;
      pendingIcons.delete(stateKey);

      iconUrl = result.blobUrl;
      width = result.width;
      height = result.height;
      pixelOffset = result.pixelOffset;
      billboardColor = result.color;
    }

    // Re-verify state exists after async await
    state = entityState[uid];
    if (!state) return;

    if (state.lastIconUrl !== iconUrl) {
      const oldIcon = state.lastIconUrl;
      registerBlobUsage(iconUrl);
      state.entity.billboard.image = iconUrl;
      state.lastIconUrl = iconUrl;
      // Unregister old after new is set
      if (oldIcon) unregisterBlobUsage(oldIcon);
    }

    state.entity.billboard.width = width;
    state.entity.billboard.height = height;
    state.entity.billboard.pixelOffset = pixelOffset;
    state.entity.billboard.color = billboardColor;
    state.lastStateKey = stateKey;
    state.lastRgbColor = rgbColor;
    unitListDirty = true;
  }

  const isSelected = viewer.selectedEntity && viewer.selectedEntity.id === uid;
  const isVisible = calculateVisibility(fullData);
  const cameraDistance = viewer.camera.positionCartographic.height;
  const showLabel = isSelected || (isVisible && cameraDistance < TACTICAL_DISTANCE);

  state.entity.show = isVisible;
  state.entity.label.show = showLabel;
  if (state.courseEntity) {
    state.courseEntity.show = isVisible;
  }

  // Only update staleAt if explicitly provided in this message
  if (stale) {
    state.staleAt = new Date(stale).getTime();
  }
  
  throttledUpdateUnitList();
}

export function removeEntity(uid) {
  const state = entityState[uid];
  if (!state) return;

  if (viewer.selectedEntity && viewer.selectedEntity.id === uid) {
    viewer.selectedEntity = undefined;
  }
  if (previouslySelectedEntityId === uid) {
    previouslySelectedEntityId = null;
  }

  if (state.lastIconUrl) {
    unregisterBlobUsage(state.lastIconUrl);
  }

  if (state.entity) viewer.entities.remove(state.entity);
  if (state.trailEntity) viewer.entities.remove(state.trailEntity);
  if (state.courseEntity) viewer.entities.remove(state.courseEntity);

  delete entityState[uid];
  unitListDirty = true;
  throttledUpdateUnitList();
}

export function updateEntitySelectionVisibility(selectedEntity) {
  if (previouslySelectedEntityId && entityState[previouslySelectedEntityId]) {
    const prevState = entityState[previouslySelectedEntityId];
    if (prevState.entity && prevState.entity.label) {
      prevState.entity.label.distanceDisplayCondition = DDC_UNSELECTED_LABEL;
      prevState.entity.label.disableDepthTestDistance = DDD_UNSELECTED;
    }
    if (prevState.trailEntity && prevState.trailEntity.polyline) {
      prevState.trailEntity.polyline.distanceDisplayCondition = DDC_UNSELECTED_TRAIL;
      prevState.trailEntity.show = calculateTrailVisibility(previouslySelectedEntityId);
    }
  }

  if (selectedEntity && selectedEntity.id && entityState[selectedEntity.id]) {
    const currentState = entityState[selectedEntity.id];
    if (currentState.entity && currentState.entity.label) {
      currentState.entity.label.distanceDisplayCondition = DDC_SELECTED;
      currentState.entity.label.disableDepthTestDistance = DDD_SELECTED;
    }
    if (currentState.trailEntity && currentState.trailEntity.polyline) {
      currentState.trailEntity.polyline.distanceDisplayCondition = DDC_SELECTED;
      currentState.trailEntity.show = true;
    }
    previouslySelectedEntityId = selectedEntity.id;
  } else {
    previouslySelectedEntityId = null;
  }
}

setInterval(() => {
  const now = Date.now();
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state) return;
    // STALE GRACE PERIOD: 120s
    // CoT stale times are often based on eventTime + small delta, 
    // which fails if clocks are slightly out of sync.
    // AIS often has very short stale times.
    if (state.staleAt && now > (state.staleAt + 120000)) {
        console.log(`Removing stale entity ${uid}: callsign=${state.lastData.callsign}, staleAt=${new Date(state.staleAt).toISOString()}, now=${new Date(now).toISOString()}`);
        removeEntity(uid);
    }
  });
}, 5000);
