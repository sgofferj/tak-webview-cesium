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
  CallbackProperty,
  VerticalOrigin,
  HorizontalOrigin,
  HeightReference,
  LabelStyle,
  PolylineOutlineMaterialProperty,
  DistanceDisplayCondition,
  Math as CesiumMath,
  HeadingPitchRange,
} from "cesium";
import ms from "milsymbol";
import { i18n, appConfig } from "./config.js";
import { viewer } from "./viewer.js";
import {
  cotToSidc,
  affilMap,
  getSquawkLabel,
  getAffiliationColor,
  throttle,
  renderGoogleIcon,
  getMGRS,
} from "./utils.js";

const MAX_DISTANCE = 100000000.0;
const HORIZON_LIMIT = 1000000.0; // 1000km
const TACTICAL_DISTANCE = 300000.0; // 300km
const GROUND_OFFSET = 2.0;

const ddcAlways = new DistanceDisplayCondition(0, MAX_DISTANCE);
const ddcTilted = new DistanceDisplayCondition(0, 100000.0); // 100km limit when tilted
const ddcTactical = new DistanceDisplayCondition(0, TACTICAL_DISTANCE);

const DDC_UNSELECTED_LABEL = ddcTactical;
const DDC_SELECTED = ddcAlways;

const DDD_UNSELECTED = HORIZON_LIMIT;
const DDD_SELECTED = MAX_DISTANCE;

const iconCache = new Map();
const blobUsageRegistry = new Map();

// Global tilt state (set by viewer.js)
export let isCameraTilted = false;
export let isTabVisible = true;

const backgroundRemovalQueue = new Set();

export function setTabVisibility(visible) {
  isTabVisible = visible;
  if (visible) {
    processBackgroundRemovals();
  }
}

function processBackgroundRemovals() {
  if (backgroundRemovalQueue.size === 0) return;
  const uids = Array.from(backgroundRemovalQueue);
  backgroundRemovalQueue.clear();
  uids.forEach((uid) => {
    removeEntity(uid);
  });
}

export function setCameraTilt(tilted) {
  if (isCameraTilted !== tilted) {
    isCameraTilted = tilted;
    applyFilter();
  }
}

export const entityState = {};
export let currentFilter = "";
export let currentAffiliationFilter = "all";
export let unitListDirty = true;
export const expandedStates = new Set();

export const staffCommentMap = new Map();
let staffCommentDefinitions = [];
let lastStaffCommentConfig = null;

export let previouslySelectedEntityId = null;

const REVERSE_KEY_MAP = {
  c: "callsign",
  t: "type",
  la: "lat",
  lo: "lon",
  al: "alt",
  co: "course",
  sp: "speed",
  s: "stale",
  b: "battery",
  h: "how",
  i: "uid",
  ip: "iconsetpath",
  cl: "color",
  r: "remarks",
  e: "emergency",
  gr: "group_role",
  gn: "group_name",
  ce: "ce",
  sc: "staff_comment",
  l: "link_url",
  sq: "squawk",
  x: "xmpp",
  m: "mail",
  p: "phone",
};

// Lock to prevent duplicate entity creation during async calls
const pendingCreation = new Set();
// Track pending icon generations to prevent race conditions
const pendingIcons = new Map();

// QUEUED REMOVAL SYSTEM to prevent Cesium rendering crashes
const pendingRemovals = new Map(); // UID -> state
let removalProcessActive = false;

function safeGetId(entity) {
  return entity && entity.id ? entity.id : null;
}

function registerBlobUsage(url) {
  if (!url || !url.startsWith("blob:")) return;
  const count = blobUsageRegistry.get(url) || 0;
  blobUsageRegistry.set(url, count + 1);
}

function unregisterBlobUsage(url) {
  if (!url || !url.startsWith("blob:")) return;
  const count = blobUsageRegistry.get(url) || 0;
  if (count <= 1) {
    // Delay revocation to ensure Cesium has finished loading the texture
    setTimeout(() => {
      // Re-verify count before revoking, in case it was re-registered
      const currentCount = blobUsageRegistry.get(url) || 0;
      if (currentCount === 0) {
        URL.revokeObjectURL(url);
      }
    }, 5000);
    blobUsageRegistry.delete(url);
  } else {
    blobUsageRegistry.set(url, count - 1);
  }
}

export function setFilters(filter, affiliation) {
  if (typeof filter === "object" && filter !== null) {
    if (filter.text !== undefined) currentFilter = filter.text.toLowerCase();
    if (filter.affiliation !== undefined) currentAffiliationFilter = filter.affiliation;
  } else {
    if (filter !== undefined) currentFilter = filter.toLowerCase();
    if (affiliation !== undefined) currentAffiliationFilter = affiliation;
  }
  applyFilter();
}

export function getFilters() {
  return {
    text: currentFilter,
    affiliation: currentAffiliationFilter,
  };
}

export function calculateVisibility(data) {
  if (!data || !data.type) return false;
  const filter = currentFilter.trim();
  const affil = currentAffiliationFilter;

  // Affiliation Filter
  if (affil !== "all") {
    const et = data.type.split("-");
    const itemAffil = et[1] ? et[1].toLowerCase() : "u";
    if (itemAffil !== affil) return false;
  }

  // Text Filter
  if (filter) {
    const searchStr = `${data.callsign || ""} ${data.uid || ""} ${data.remarks || ""}`.toLowerCase();
    if (!searchStr.includes(filter)) return false;
  }

  return true;
}

export function calculateTrailVisibility(uid) {
  const state = entityState[uid];
  if (!state || !state.trailEntity) return false;

  const selectedId = safeGetId(viewer.selectedEntity);
  const isSelected =
    selectedId &&
    (selectedId === uid ||
      selectedId === uid + "-trail" ||
      selectedId === uid + "-course");
  const isVisible = calculateVisibility(state.lastData);
  return isVisible && isSelected;
}

export function applyFilter() {
  if (!viewer) return;
  unitListDirty = true;
  const selectedId = safeGetId(viewer.selectedEntity);

  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state || state._isRemoved) return;

    const isSelected =
      selectedId &&
      (selectedId === uid ||
        selectedId === uid + "-trail" ||
        selectedId === uid + "-course");
    const isVisible = calculateVisibility(state.lastData);

    // Determine Target DDC based on Selection and Tilt
    const iconDDC = isSelected
      ? ddcAlways
      : isCameraTilted
        ? ddcTilted
        : ddcAlways;
    const labelDDC = isSelected
      ? ddcAlways
      : isCameraTilted
        ? ddcTilted
        : ddcTactical;

    // Icons follow filter
    if (state.entity) {
      state.entity.show = isVisible || isSelected;

      // Update icon visual range based on camera tilt
      if (state.entity.billboard) {
        state.entity.billboard.distanceDisplayCondition = iconDDC;
      }

      // Labels follow distanceDisplayCondition automatically
      if (state.entity.label) {
        state.entity.label.distanceDisplayCondition = labelDDC;
      }
    }

    if (state.courseEntity && state.courseEntity.billboard) {
      state.courseEntity.billboard.distanceDisplayCondition = iconDDC;
    }

    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
    if (state.courseEntity) {
      state.courseEntity.show = state.entity.show && state.lastData.course !== undefined;
    }
  });
}

export function createDescription(data) {
  const {
    callsign,
    type,
    uid,
    lat,
    lon,
    alt,
    course,
    speed,
    remarks,
    link_url,
    battery,
    xmpp,
    mail,
    phone,
  } = data;
  let html = `<div style="font-family: sans-serif; padding: 5px;">`;
  html += `<b style="font-size: 1.2em; color: #4af;">${callsign || uid}</b><br/>`;
  html += `<small style="color: #888;">${type}</small><br/><br/>`;

  if (lat !== undefined && lon !== undefined) {
    html += `<b>Pos:</b> ${lat.toFixed(5)}, ${lon.toFixed(5)}<br/>`;
    html += `<b>MGRS:</b> ${getMGRS(lon, lat)}<br/>`;
  }
  if (alt !== undefined) {
    html += `<b>Alt:</b> ${alt.toFixed(1)}m<br/>`;
  }
  if (course !== undefined) {
    html += `<b>Course:</b> ${course.toFixed(1)}°<br/>`;
  }
  if (speed !== undefined) {
    html += `<b>Speed:</b> ${(speed * 3.6).toFixed(1)} km/h<br/>`;
  }

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

function refreshStaffCommentDefinitions() {
  if (lastStaffCommentConfig === appConfig.tak_staff_comments) return staffCommentDefinitions;
  
  lastStaffCommentConfig = appConfig.tak_staff_comments;
  staffCommentDefinitions = (appConfig.tak_staff_comments || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((def) => {
      const [search, label] = def.split("=");
      return { search: search.trim(), label: (label || search).trim() };
    });
  
  // Config changed, rebuild the map for all current entities
  staffCommentMap.clear();
  staffCommentDefinitions.forEach(def => {
    staffCommentMap.set(def.search, new Set());
  });

  Object.keys(entityState).forEach(uid => {
    const state = entityState[uid];
    if (state && !state._isRemoved) {
      _doUpdateStaffCommentMatching(uid, state.lastData, state);
    }
  });

  return staffCommentDefinitions;
}

function checkStaffCommentMatch(data, search, label) {
  const sc = data.staff_comment;
  if (sc === search || sc === label) return true;

  const searchLower = search.toLowerCase();
  for (const key in data) {
    const val = data[key];
    if (typeof val === "string" && val.toLowerCase().includes(searchLower)) {
      return true;
    }
  }
  return false;
}

function _doUpdateStaffCommentMatching(uid, data, state) {
  const currentMatches = new Set();
  
  staffCommentDefinitions.forEach(({ search, label }) => {
    if (checkStaffCommentMatch(data, search, label)) {
      currentMatches.add(search);
      if (!staffCommentMap.has(search)) {
        staffCommentMap.set(search, new Set());
      }
      staffCommentMap.get(search).add(uid);
    }
  });

  // Remove from old matches that are no longer matches
  if (state.matchedStaffComments) {
    state.matchedStaffComments.forEach(oldSearch => {
      if (!currentMatches.has(oldSearch)) {
        const set = staffCommentMap.get(oldSearch);
        if (set) set.delete(uid);
      }
    });
  }
  state.matchedStaffComments = currentMatches;
}

function updateStaffCommentMatching(uid, data, state) {
  refreshStaffCommentDefinitions();
  _doUpdateStaffCommentMatching(uid, data, state);
}

export function updateUnitListUI() {
  if (!unitListDirty) return;
  const content = document.getElementById("unitListContent");
  if (!content) return;

  const categories = {
    incidents: { label: i18n.categoryIncidents, groups: {} },
    aircraft: { label: i18n.categoryAircraft, groups: {} },
    vessels: { label: i18n.categoryVessels, groups: {} },
    other: { label: i18n.categoryOther, groups: {} },
  };
  const currentAffilMap = affilMap(i18n);

  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state || state._isRemoved || !state.entity || !state.entity.show) return;
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
    const catExpanded = expandedStates.has(catKey);
    html += `<div class="unit-group ${!catExpanded ? "collapsed" : ""}" id="group-${catKey}">
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
      const isSubExpanded = expandedStates.has(subKey);
      html += `<div class="affiliation-group ${!isSubExpanded ? "collapsed" : ""}" id="group-${subKey}">
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
  
  updateStaffCommentsUI();
  unitListDirty = false;
}

export function updateStaffCommentsUI() {
  const content = document.getElementById("staffCommentsContent");
  if (!content) return;

  const commentDefs = refreshStaffCommentDefinitions();

  if (commentDefs.length === 0) {
    content.innerHTML = "";
    return;
  }

  let html = "";
  commentDefs.forEach(({ search, label }) => {
    const uids = staffCommentMap.get(search) || new Set(); // Ensure uids is a Set, even if empty
    const matchingUnits = [];

    uids.forEach(uid => {
      const state = entityState[uid];
      if (state && !state._isRemoved) { // Only show active, non-removed entities
        matchingUnits.push({
          uid: uid,
          callsign: state.lastData.callsign,
          color: state.lastRgbColor || "white",
          iconUrl: state.lastIconUrl || "",
        });
      }
    });

    const groupKey = `staff-${search}`;
    const isExpanded = expandedStates.has(groupKey);
    html += `<div class="unit-group ${!isExpanded ? "collapsed" : ""}" id="group-${groupKey}">
              <div class="unit-group-header" onclick="toggleCollapse('${groupKey}')">${label} (${matchingUnits.length})</div>
              <div class="unit-group-content">`;

    if (matchingUnits.length > 0) {
      matchingUnits
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .forEach((unit) => {
          html += `<div class="unit-item" id="unit-staff-${unit.uid}" onclick="zoomToUnit('${unit.uid}')">
                    <img class="unit-icon" src="${unit.iconUrl}" />
                    <span class="unit-name" style="color: ${unit.color}">${unit.callsign}</span>
                </div>`;
        });
    } else {
      html += `<div style="text-align:center; padding:10px; color:#888; font-size:0.8em;">${i18n.noMatchingUnits || "No matching units"}</div>`;
    }
    html += `</div></div>`;
  });

  content.innerHTML = html || `<div style="text-align:center; padding:20px; color:#888;">${i18n.noStaffCommentDefs || "No staff comment definitions configured."}</div>`;
}

export const throttledUpdateUnitList = throttle(updateUnitListUI, 1000);

window.toggleCollapse = function (key) {
  if (expandedStates.has(key)) expandedStates.delete(key);
  else expandedStates.add(key);
  unitListDirty = true;
  updateUnitListUI();
};

window.zoomToUnit = function (uid) {
  const state = entityState[uid];
  if (state && !state._isRemoved && viewer) {
    viewer.selectedEntity = state.entity;
    viewer.flyTo(state.entity, {
      offset: new HeadingPitchRange(0, -Math.PI / 2, 100000),
    });
  }
};

function drawGroupIcon(name, role, how) {
  const canvas = document.createElement("canvas");
  canvas.width = 156;
  canvas.height = 156;
  const ctx = canvas.getContext("2d");
  const cx = 78,
    cy = 78;

  const groupColorMap = {
    White: "#ffffff",
    Yellow: "#ffff00",
    Orange: "#ffa500",
    Magenta: "#ff00ff",
    Red: "#ff0000",
    Maroon: "#800000",
    Purple: "#800080",
    Cyan: "#00ffff",
    Blue: "#0000ff",
    Green: "#00ff00",
    "Dark Green": "#006400",
    Brown: "#a52a2a",
  };

  const roleAbbrMap = {
    HQ: "HQ",
    "Team Member": "none",
    "Team Lead": "TL",
    Sniper: "SN",
    Medic: "MD",
    "Forward Observer": "FO",
    RTO: "RO",
    K9: "K9",
    Pilot: "PL",
  };

  const fillColor = groupColorMap[name] || "#ffffff";
  const rawAbbr = roleAbbrMap[role] || (role ? role.substring(0, 3).toUpperCase() : "");
  const abbr = rawAbbr === "none" ? "" : rawAbbr;

  ctx.beginPath();
  ctx.arc(cx, cy, 71.5, 0, 2 * Math.PI); // Proportional to 88 on 192
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.lineWidth = 12; // Keeps 2px border at 26x26 icon size
  ctx.strokeStyle = "black";
  ctx.stroke();

  if (how !== "m-g") {
    ctx.beginPath();
    ctx.moveTo(cx - 50, cy + 50); // Proportional to 62 on 192
    ctx.lineTo(cx + 50, cy - 50);
    ctx.lineWidth = 16;
    ctx.strokeStyle = "black";
    ctx.stroke();
  }

  if (abbr) {
    ctx.font = "bold 65px sans-serif"; // Proportional to 80 on 192
    const textMetrics = ctx.measureText(abbr);
    ctx.fillStyle = fillColor;
    // Box behind text for legibility
    ctx.fillRect(
      cx - textMetrics.width / 2 - 8,
      cy - 40,
      textMetrics.width + 16,
      80,
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
  const uid = data.uid || data.i;
  if (!uid) return;

  // RESCUE: If it's in the background removal queue, but we got a fresh update, remove from queue
  if (backgroundRemovalQueue.has(uid)) {
    backgroundRemovalQueue.delete(uid);
  }

  // RESCUE: If it's in the removal queue, but we got a fresh update, stop the removal
  if (pendingRemovals.has(uid)) {
    const rescuedState = pendingRemovals.get(uid);
    pendingRemovals.delete(uid);
    rescuedState._isRemoved = false;
    entityState[uid] = rescuedState; // Re-add to active map
  }

  let state = entityState[uid];
  if (!state && pendingCreation.has(uid)) {
    // If already creating, wait a bit or ignore to avoid duplicates
    return;
  }

  if (state) {
    if (state._isRemoved) return;
    data.uid = uid;
    for (const k in data) {
      if (data[k] !== undefined) state.lastData[k] = data[k];
    }
  } else if (!data.type) return;

  const fullData = state ? state.lastData : data;
  const {
    callsign: rawCallsign,
    type,
    lat,
    lon,
    alt,
    course,
    stale,
    color,
    iconsetpath,
    group_name,
    group_role,
    how,
    squawk,
  } = fullData;

  // SAFETY: Filter non-finite coordinates
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const callsign = rawCallsign || uid || "Unknown";

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
  const staff_comment = fullData.staff_comment || "";

  // Ensure staff_comment is part of the key for milsymbols so they cache correctly
  const stateKey = useTeamCircle
    ? `group-${group_name}-${group_role}-${color}-${how}`
    : iconsetUrl
      ? `icon-${iconsetUrl}-${rgbColor}`
      : `${sidc}-${color}-${squawk}-${staff_comment}`;

  const description = createDescription({ ...fullData, callsign });

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
          show: true,
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
          distanceDisplayCondition: ddcTactical,
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
          distanceDisplayCondition: ddcAlways,
          disableDepthTestDistance: HORIZON_LIMIT,
          heightReference: iconRef,
        },
      });

      state = {
        uid,
        entity,
        trailEntity,
        courseEntity,
        history,
        lastStateKey: "",
        lastData: { ...fullData, callsign },
        lastIconUrl: "",
        lastPosition: position,
        _isRemoved: false,
      };

      // Double check if removed during creation
      if (pendingRemovals.has(uid)) {
        pendingCreation.delete(uid);
        return;
      }

      entityState[uid] = state;
      unitListDirty = true;
    } finally {
      pendingCreation.delete(uid);
    }
  } else {
    // Update existing state
    if (!position.equals(state.lastPosition)) {
      state.entity.position = position;
      state.lastPosition = position;
      state.history.push(anchorPosition);
      if (state.history.length > 50) state.history.shift();
      unitListDirty = true;
    }

    state.entity.description = description;

    if (state.entity.billboard.heightReference !== iconRef) {
      state.entity.billboard.heightReference = iconRef;
      state.entity.label.heightReference = iconRef;
    }

    if (
      viewer.clock &&
      state.entity.label &&
      state.entity.label.text &&
      state.entity.label.text.getValue(viewer.clock.currentTime) !== callsign
    ) {
      state.entity.label.text = callsign;
      unitListDirty = true;
    }

    const selectedId = safeGetId(viewer.selectedEntity);
    const isSelected =
      selectedId &&
      (selectedId === uid ||
        selectedId === uid + "-trail" ||
        selectedId === uid + "-course");
    const isVisible = calculateVisibility(state.lastData);
    const trailVisible = isVisible && isSelected;
    state.trailEntity.show = trailVisible;
    if (trailVisible) {
      state.trailEntity.polyline.positions = [...state.history];
    }
  }

  const hasCourse = course !== undefined && course !== null;
  if (hasCourse) {
    state.courseEntity.position = position;
    if (
      !state.courseEntity.billboard.rotation ||
      typeof state.courseEntity.billboard.rotation.getValue !== "function"
    ) {
      state.courseEntity.billboard.rotation = new CallbackProperty(() => {
        const s = entityState[uid];
        if (!s || s._isRemoved || !s.lastData || s.lastData.course === undefined)
          return 0;
        return -CesiumMath.toRadians(s.lastData.course) + viewer.camera.heading;
      }, false);
    }
    if (
      !state.courseEntity.billboard.pixelOffset ||
      typeof state.courseEntity.billboard.pixelOffset.getValue !== "function"
    ) {
      state.courseEntity.billboard.pixelOffset = new Cartesian2(0, 0);
      state.courseEntity.billboard.pixelOffset = new CallbackProperty(() => {
        const s = entityState[uid];
        if (
          !s ||
          s._isRemoved ||
          !s.lastData ||
          s.lastData.course === undefined
        ) {
          return new Cartesian2(0, -22);
        }
        const angle =
          CesiumMath.toRadians(s.lastData.course) - viewer.camera.heading;
        const dist = 22;
        return new Cartesian2(Math.sin(angle) * dist, -Math.cos(angle) * dist);
      }, false);
    }
    state.courseEntity.billboard.heightReference = iconRef;
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
      // We don't register here because we register when assigning to state.lastIconUrl below
    } else if (pendingIcons.has(stateKey)) {
      const result = await pendingIcons.get(stateKey);
      iconUrl = result.blobUrl;
      width = result.width;
      height = result.height;
      pixelOffset = result.pixelOffset;
      billboardColor = result.color;
    } else {
      const generateIcon = async () => {
        let iUrl,
          pOff = new Cartesian2(0, 0),
          w = 28,
          h = 28,
          bCol = Color.WHITE;

        if (useTeamCircle) {
          const canvas = drawGroupIcon(group_name, group_role, how);
          iUrl = await canvasToBlobUrl(canvas);
          w = 26;
          h = 26;
        } else if (iconsetUrl) {
          iUrl = iconsetUrl;
          bCol = color ? cesiumColor : Color.WHITE;
        } else {
          const symbolOptions = {
            size: 21,
            padding: 15,
            infoColor: "black",
            infoBackground: "rgba(255,255,255,0.5)",
          };
          if (staff_comment) symbolOptions.staffComments = staff_comment;
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
        registerBlobUsage(iUrl); // Pre-register for cache
        iconCache.set(stateKey, cacheEntry);
        return cacheEntry;
      };
      const iconPromise = generateIcon();
      pendingIcons.set(stateKey, iconPromise);
      const result = await iconPromise;
      pendingIcons.delete(stateKey);
      iconUrl = result.blobUrl;
      pixelOffset = result.pixelOffset;
      width = result.width;
      height = result.height;
      billboardColor = result.color;
    }

    // Re-verify state exists after async await
    state = entityState[uid];
    if (!state || state._isRemoved) return;

    if (state.lastIconUrl !== iconUrl) {
      const oldIcon = state.lastIconUrl;
      registerBlobUsage(iconUrl);
      state.entity.billboard.image = iconUrl;
      state.lastIconUrl = iconUrl;
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

  if (stale) {
    state.staleAt = new Date(stale).getTime();
  }

  // Final visibility sync (covers selection changes and filter updates)
  const isVisible = calculateVisibility(state.lastData);
  const selectedId = safeGetId(viewer.selectedEntity);
  const isSelected =
    selectedId &&
    (selectedId === uid ||
      selectedId === uid + "-trail" ||
      selectedId === uid + "-course");

  state.entity.show = isVisible || isSelected;
  if (state.courseEntity) {
    state.courseEntity.show = state.entity.show && (state.lastData.course !== undefined);
  }

  throttledUpdateUnitList();
  updateStaffCommentMatching(uid, state.lastData, state);
  updateStaffCommentsUI();
}

function processRemovalQueue() {
  if (pendingRemovals.size === 0) {
    removalProcessActive = false;
    return;
  }
  if (removalProcessActive) return;
  removalProcessActive = true;

  const processBatch = () => {
    if (!viewer || !viewer.entities) {
      removalProcessActive = false;
      return;
    }

    viewer.entities.suspendEvents();
    try {
      const entries = Array.from(pendingRemovals.entries());
      const batchSize = 20;
      const batch = entries.slice(0, batchSize);

      batch.forEach(([uid, state]) => {
        pendingRemovals.delete(uid);

        if (state) {
          // If a new state was created with same UID while this one was pending removal,
          // don't remove anything - the new state owns these entities now OR has new ones.
          // BUT: Usually we want to remove the OLD entities. 
          // Re-verify if this is the CURRENT state for this UID
          if (entityState[uid] === state) {
             // If it is in entityState, it shouldn't be in pendingRemovals unless something is wrong.
             return;
          }

          const subEntities = [
            state.entity,
            state.trailEntity,
            state.courseEntity,
          ].filter((ent) => ent !== null && ent !== undefined);

          const selectedId = safeGetId(viewer.selectedEntity);
          if (
            selectedId &&
            (selectedId === uid ||
              selectedId === uid + "-trail" ||
              selectedId === uid + "-course")
          ) {
            viewer.selectedEntity = undefined;
          }
          const trackedId = safeGetId(viewer.trackedEntity);
          if (
            trackedId &&
            (trackedId === uid ||
              trackedId === uid + "-trail" ||
              trackedId === uid + "-course")
          ) {
            viewer.trackedEntity = undefined;
          }

          if (state.lastIconUrl) {
            unregisterBlobUsage(state.lastIconUrl);
          }

          subEntities.forEach((ent) => {
            if (!ent || !viewer.entities.contains(ent)) return;

            if (ent === state.entity) state.entity = null;
            if (ent === state.trailEntity) state.trailEntity = null;
            if (ent === state.courseEntity) state.courseEntity = null;

            ent.show = false;
            // Clear properties to break potential circular refs or callback property chains
            if (ent.billboard) {
              ent.billboard.show = false;
              ent.billboard.image = undefined;
              ent.billboard.rotation = undefined;
              ent.billboard.pixelOffset = undefined;
            }
            if (ent.label) {
              ent.label.show = false;
              ent.label.text = undefined;
            }
            viewer.entities.remove(ent);
          });
        }
      });

      unitListDirty = true;
      throttledUpdateUnitList();
    } finally {
      viewer.entities.resumeEvents();

      if (pendingRemovals.size > 0) {
        requestAnimationFrame(processBatch);
      } else {
        removalProcessActive = false;
      }
    }
  };

  requestAnimationFrame(processBatch);
}

export function removeEntity(uid) {
  if (!isTabVisible) {
    backgroundRemovalQueue.add(uid);
    return;
  }
  const state = entityState[uid];
  if (!state) return;

  delete entityState[uid];
  state._isRemoved = true;

  // Clean up staff comment matches
  if (state.matchedStaffComments) {
    state.matchedStaffComments.forEach(search => {
      const set = staffCommentMap.get(search);
      if (set) set.delete(uid);
    });
  }

  if (state.entity) state.entity.show = false;
  if (state.trailEntity) state.trailEntity.show = false;
  if (state.courseEntity) state.courseEntity.show = false;

  pendingRemovals.set(uid, state);
  if (!removalProcessActive) processRemovalQueue();
}

export function updateEntitySelectionVisibility(selectedEntity) {
  const selectedId = safeGetId(selectedEntity);
  let baseUid = selectedId;
  if (selectedId) {
    if (selectedId.endsWith("-trail"))
      baseUid = selectedId.replace("-trail", "");
    else if (selectedId.endsWith("-course"))
      baseUid = selectedId.replace("-course", "");
  }

  if (previouslySelectedEntityId && entityState[previouslySelectedEntityId]) {
    const prevState = entityState[previouslySelectedEntityId];
    if (prevState.entity && prevState.entity.label) {
      prevState.entity.label.distanceDisplayCondition = DDC_UNSELECTED_LABEL;
      prevState.entity.label.disableDepthTestDistance = DDD_UNSELECTED;
    }
    if (prevState.trailEntity && prevState.trailEntity.polyline) {
      prevState.trailEntity.polyline.distanceDisplayCondition = ddcTactical;
      prevState.trailEntity.show = calculateTrailVisibility(
        previouslySelectedEntityId,
      );
    }
  }

  if (baseUid && entityState[baseUid]) {
    const currentState = entityState[baseUid];
    if (currentState.entity && currentState.entity.label) {
      currentState.entity.label.distanceDisplayCondition = DDC_SELECTED;
      currentState.entity.label.disableDepthTestDistance = DDD_SELECTED;
    }
    if (currentState.trailEntity && currentState.trailEntity.polyline) {
      currentState.trailEntity.polyline.distanceDisplayCondition = DDC_SELECTED;
      currentState.trailEntity.show = true;
    }
    previouslySelectedEntityId = baseUid;
  } else {
    previouslySelectedEntityId = null;
  }
}

setInterval(() => {
  const now = Date.now();
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (!state || state._isRemoved || backgroundRemovalQueue.has(uid)) return;
    // STALE GRACE PERIOD: 120s
    if (state.staleAt && now > state.staleAt + 120000) {
      console.log(
        `Removing stale entity ${uid}: callsign=${state.lastData.callsign}, staleAt=${new Date(state.staleAt).toISOString()}, now=${new Date(now).toISOString()}`,
      );
      removeEntity(uid);
    }
  });
}, 30000);
