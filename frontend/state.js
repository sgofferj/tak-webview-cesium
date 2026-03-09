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
  PolylineOutlineMaterialProperty,
  HeadingPitchRange,
  HeightReference,
} from "cesium";
import ms from "milsymbol";
import mgrs from "mgrs";
import { i18n, appConfig } from "./config.js";
import { viewer } from "./viewer.js";
import {
  cotToSidc,
  getAffiliationColor,
  getSquawkLabel,
  affilMap,
  throttle,
  getDestination,
} from "./utils.js";

export const entityState = {};
export let currentFilter = "";
export let currentAffiliationFilter = "all";
export let showAllTrails = false;
export let unitListDirty = true;
export const collapsedStates = new Set(["incidents", "aircraft", "vessels", "other"]);

const MAX_DISTANCE = 10000000.0;
const HORIZON_LIMIT = 1000000.0; // 1000km
const TACTICAL_DISTANCE = 100000.0; // 100km

const REVERSE_KEY_MAP = {
  i: "uid", t: "type", c: "callsign", la: "lat", lo: "lon", al: "alt",
  s: "stale", r: "remarks", sq: "squawk", co: "course", sp: "speed",
  l: "link_url", cl: "color", ip: "iconsetpath", e: "emergency",
  x: "xmpp", m: "mail", p: "phone", b: "battery", h: "how",
  gr: "group_role", gn: "group_name", ce: "ce",
};

// Global icon cache to prevent memory leaks and redundant rendering
const iconCache = new Map();

export function setFilters(filter, affiliation) {
  if (filter !== undefined) currentFilter = filter.toLowerCase();
  if (affiliation !== undefined) currentAffiliationFilter = affiliation;
  applyFilter();
}

export function setShowAllTrails(val) {
  showAllTrails = val;
  unitListDirty = true;
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
  });
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
    else if (["h", "s", "j", "k"].includes(affilCode)) simpleAffil = "h";
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
  const isSelected = viewer.selectedEntity && viewer.selectedEntity.id === uid;
  const isVisible = calculateVisibility(state.lastData);
  return isVisible && (showAllTrails || isSelected);
}

export function applyFilter() {
  unitListDirty = true;
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    const isVisible = calculateVisibility(state.lastData);
    state.entity.show = isVisible;
    if (state.vectorEntity) {
        state.vectorEntity.show = isVisible && state.hasVector;
    }
    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
  });
  throttledUpdateUnitList();
}

export function createDescription(data) {
  const {
    uid, callsign, remarks, link_url, emergency, xmpp, mail, phone,
    battery, lat, lon, alt, speed,
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
    } catch (e) { console.error("MGRS failed", e); }
    html += `<b>Lat/Lon:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}<br/>`;
  }
  if (alt !== undefined && alt !== null) html += `<b>Alt:</b> ${alt} m<br/>`;
  if (speed !== undefined && speed !== null) html += `<b>Speed:</b> ${(speed * 3.6).toFixed(1)} km/h<br/>`;

  if (xmpp || mail || phone) {
    html += `<br/><b>Contact information:</b><br/>`;
    if (xmpp) html += `<b>XMPP:</b> <a href="xmpp:${xmpp}" style="color: #4af;">${xmpp}</a><br/>`;
    if (mail) html += `<b>Email:</b> <a href="mailto:${mail}" style="color: #4af;">${mail}</a><br/>`;
    if (phone) html += `<b>Phone:</b> <a href="tel:${phone}" style="color: #4af;">${phone}</a><br/>`;
  }

  if (data.squawk) {
    const label = getSquawkLabel(data.squawk, i18n);
    if (label) html += `<b>${i18n.emergencyLabel || "Emergency"}:</b> <span style="color: red; font-weight: bold;">${label}</span><br/>`;
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
      .replace(/#(\w+)/g, '<a class="hashtag-link" data-tag="#$1" style="color: #4af; cursor: pointer; text-decoration: underline;">#$1</a>')
      .replace(/\n\s*\n/g, "\n").trim().replace(/\n/g, "<br/>");
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M16,20H8V6H16V20M16.67,4H15V2H9V4H7.33A0.67,0.67 0 0,0 6.67,4.67V20.33A0.67,0.67 0 0,0 7.33,21H16.67A0.67,0.67 0 0,0 7.33,20.33V4.67A0.67,0.67 0 0,0 16.67,4Z" /></svg>
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
    if (!state.entity.show) return;
    const data = state.lastData;
    const uidLower = uid.toLowerCase();
    let cat = "other";
    if (uidLower.includes("gdacs")) cat = "incidents";
    else if (uidLower.includes("icao") || (data.remarks || "").toLowerCase().includes("#adsb")) cat = "aircraft";
    else if (uidLower.includes("ais") || (data.remarks || "").toLowerCase().includes("#ais")) cat = "vessels";

    const et = (data.type || "u-u-g").split("-");
    const affilCode = et[1] ? et[1].toLowerCase() : "u";
    const affilLabel = currentAffilMap[affilCode] || i18n.affiliationUnknown;

    if (!categories[cat].groups[affilLabel]) categories[cat].groups[affilLabel] = [];
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
    const totalCount = Object.values(cat.groups).reduce((sum, g) => sum + g.length, 0);
    const catCollapsed = collapsedStates.has(catKey);
    html += `<div class="unit-group ${catCollapsed ? "collapsed" : ""}">
            <div class="unit-group-header" onclick="toggleCollapse('${catKey}')">${cat.label} (${totalCount})</div>
            <div class="unit-group-content">`;
    [i18n.affiliationFriendly, i18n.affiliationHostile, i18n.affiliationNeutral, i18n.affiliationUnknown].forEach((affil) => {
      const units = cat.groups[affil];
      if (!units || units.length === 0) return;
      const subKey = `${catKey}-${affil}`;
      const isSubCollapsed = collapsedStates.has(subKey);
      html += `<div class="affiliation-group ${isSubCollapsed ? "collapsed" : ""}">
                <div class="affiliation-header" onclick="toggleCollapse('${isSubCollapsed ? "" : subKey}')">${affil} (${units.length})</div>
                <div class="affiliation-content">`;
      units.sort((a, b) => a.callsign.localeCompare(b.callsign)).forEach((unit) => {
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
  content.innerHTML = html || `<div style="text-align:center; padding:20px; color:#888;">${i18n.noActiveUnits}</div>`;
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
  if (state) {
    viewer.selectedEntity = state.entity;
    viewer.flyTo(state.entity, { offset: new HeadingPitchRange(0, -Math.PI / 2, 100000) });
  }
};

function drawGroupIcon(name, role, how) {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const cx = 128; const cy = 128;

  const groupColors = {
    Cyan: "#00FFFF", Green: "#00FF00", Blue: "#0000FF", Red: "#FF0000",
    Yellow: "#FFFF00", Magenta: "#FF00FF", White: "#FFFFFF", Maroon: "#800000",
    "Dark Blue": "#00008B", "Dark Green": "#006400", Purple: "#800080",
    Orange: "#FFA500", Brown: "#A52A2A",
  };
  const roleAbbrMap = { 
    "Team Member": "TM", "Team Lead": "TL", "HQ": "HQ", "Sniper": "S", 
    "Medic": "M", "Forward Observer": "FO", "RTO": "R", "K9": "K9"
  };
  const fillColor = groupColors[name] || name || "#FFFFFF";
  const abbr = roleAbbrMap[role] || (role ? role.substring(0, 3).toUpperCase() : "");

  ctx.beginPath();
  ctx.arc(cx, cy, 96, 0, 2 * Math.PI);
  ctx.fillStyle = fillColor; ctx.fill();
  ctx.lineWidth = 8; ctx.strokeStyle = "black"; ctx.stroke();

  if (how !== "m-g") {
    ctx.beginPath();
    ctx.moveTo(cx - 68, cy + 68);
    ctx.lineTo(cx + 68, cy - 68);
    ctx.lineWidth = 16; ctx.strokeStyle = "black"; ctx.stroke();
  }

  if (abbr) {
    ctx.font = "bold 72px sans-serif";
    const textMetrics = ctx.measureText(abbr);
    ctx.fillStyle = fillColor;
    ctx.fillRect(cx - textMetrics.width / 2 - 8, cy - 44, textMetrics.width + 16, 88);
    ctx.fillStyle = "black";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(abbr, cx, cy);
  }
  return canvas;
}

export function updateEntity(incomingData) {
  const data = {};
  for (const key in incomingData) {
    data[REVERSE_KEY_MAP[key] || key] = incomingData[key];
  }
  const { uid } = data;
  let state = entityState[uid];
  if (state) {
    data.uid = uid;
    for (const k in data) {
      if (data[k] !== undefined) {
        state.lastData[k] = data[k];
      }
    }
  } else if (!data.type) return;

  const fullData = state ? state.lastData : data;
  const {
    callsign, type, lat, lon, alt, color, iconsetpath, emergency,
    course, squawk, stale, how, group_role, group_name, speed,
  } = fullData;

  const sidc = cotToSidc((type || "").toUpperCase());
  let iconsetUrl = null;
  if (iconsetpath) {
    const parts = iconsetpath.split("/").filter(p => p.length > 0);
    const setUid = parts.shift();
    const iconFile = parts.join("/");
    if (window.availableIconsets && window.availableIconsets[setUid]) {
      const set = window.availableIconsets[setUid];
      if (iconFile) iconsetUrl = encodeURI(`${set.url_path}/${iconFile}`);
      else if (set.type_map && set.type_map[type]) iconsetUrl = encodeURI(`${set.url_path}/${set.type_map[type]}`);
    } else iconsetUrl = iconsetpath.startsWith("/") ? iconsetpath : `/iconsets/${iconsetpath}`;
  }

  let rgbColor = "white", cesiumColor = Color.WHITE;
  if (color) {
    const argb = parseInt(color);
    const r = (argb >> 16) & 0xff, g = (argb >> 8) & 0xff, b = argb & 0xff;
    rgbColor = `rgb(${r},${g},${b})`; cesiumColor = Color.fromBytes(r, g, b, 255);
  }
  const effectiveColor = color ? cesiumColor : getAffiliationColor(type);
  
  const clampedAlt = (alt > 9000000) ? 0 : alt;
  const position = Cartesian3.fromDegrees(lon, lat, clampedAlt || 0);

  // STRICT TEAM CIRCLE LOGIC: If BOTH name and role are present, MUST use team circle.
  const useTeamCircle = !!group_name && !!group_role;

  const stateKey = useTeamCircle ? `group-${group_name}-${group_role}-${color}-${how}` :
                   iconsetUrl ? `icon-${iconsetUrl}-${rgbColor}` : 
                   `${sidc}-${color}-${squawk}`;
  
  const description = createDescription(fullData);
  const ddcAlways = new DistanceDisplayCondition(0, MAX_DISTANCE);
  const ddcTactical = new DistanceDisplayCondition(0, TACTICAL_DISTANCE); 

  if (!state) {
    const entity = viewer.entities.add({
      id: uid, name: callsign, position: position,
      billboard: { 
        horizontalOrigin: HorizontalOrigin.CENTER, verticalOrigin: VerticalOrigin.CENTER, 
        eyeOffset: new Cartesian3(0, 0, -10),
        distanceDisplayCondition: ddcAlways, disableDepthTestDistance: HORIZON_LIMIT 
      },
      label: {
        text: callsign, font: "bold 14px sans-serif", style: LabelStyle.FILL_AND_OUTLINE, fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 4,
        showBackground: true, backgroundColor: new Color(0, 0, 0, 0.4), backgroundPadding: new Cartesian2(7, 5),
        verticalOrigin: VerticalOrigin.TOP, horizontalOrigin: HorizontalOrigin.CENTER, 
        pixelOffset: new Cartesian2(0, 20), eyeOffset: new Cartesian3(0, 0, -20),
        distanceDisplayCondition: ddcTactical, disableDepthTestDistance: HORIZON_LIMIT,
      },
      description: description,
    });
    state = { entity, history: [position], lastStateKey: "", lastData: data, lastIconUrl: "" };
    entityState[uid] = state;
    unitListDirty = true;
  } else {
    state.entity.position = position;
    state.entity.description = description;
    if (state.entity.label.text.getValue(viewer.clock.currentTime) !== callsign) {
        state.entity.label.text = callsign;
        unitListDirty = true;
    }
    const isEmergency = emergency && emergency.status === "active";
    const wasEmergency = state.lastData.emergency && state.lastData.emergency.status === "active";
    if (isEmergency !== wasEmergency) unitListDirty = true;
  }

  if (state.lastStateKey !== stateKey) {
    if (iconCache.has(stateKey)) {
        const cached = iconCache.get(stateKey);
        state.entity.billboard.image = cached.dataUrl;
        state.entity.billboard.width = cached.width; state.entity.billboard.height = cached.height;
        state.entity.billboard.pixelOffset = cached.pixelOffset || new Cartesian2(0, 0);
        state.entity.billboard.color = cached.color || Color.WHITE;
        state.lastIconUrl = cached.dataUrl;
    } else {
        let iconDataUrl, pixelOffset = new Cartesian2(0, 0), width = 28, height = 28, billboardColor = Color.WHITE;
        if (useTeamCircle) {
          const canvas = drawGroupIcon(group_name, group_role, how);
          iconDataUrl = canvas.toDataURL();
          width = 32; height = 32;
        } else if (iconsetUrl) {
          iconDataUrl = iconsetUrl;
          billboardColor = color ? cesiumColor : Color.WHITE;
        } else {
          const symbolOptions = { size: 21, padding: 10 }; 
          if (getSquawkLabel(squawk, i18n)) symbolOptions.staffComments = getSquawkLabel(squawk, i18n);
          if (course !== null && course !== undefined && type.split("-")[2] === "A") symbolOptions.direction = course;
          const symbol = new ms.Symbol(sidc, symbolOptions);
          const canvas = symbol.asCanvas();
          const iconAnchor = symbol.getAnchor();
          const iconSize = symbol.getSize();
          iconDataUrl = canvas.toDataURL();
          const scale = 1.1;
          width = iconSize.width * scale;
          height = iconSize.height * scale;
          pixelOffset = new Cartesian2((iconSize.width / 2 - iconAnchor.x) * scale, (iconSize.height / 2 - iconAnchor.y) * scale);
        }
        state.entity.billboard.image = iconDataUrl;
        state.entity.billboard.width = width; state.entity.billboard.height = height;
        state.entity.billboard.pixelOffset = pixelOffset;
        state.entity.billboard.color = billboardColor;
        state.lastIconUrl = iconDataUrl;
        iconCache.set(stateKey, { dataUrl: iconDataUrl, pixelOffset, width, height, color: billboardColor });
    }
    state.lastRgbColor = rgbColor;
    state.lastStateKey = stateKey;
    unitListDirty = true;
  }
  state.staleAt = stale ? new Date(stale).getTime() : null;
  state.entity.show = calculateVisibility(fullData);
  throttledUpdateUnitList();
}

export function removeEntity(uid) {
  const state = entityState[uid];
  if (!state) return;
  viewer.entities.remove(state.entity);
  if (state.trailEntity) viewer.entities.remove(state.trailEntity);
  delete entityState[uid];
  unitListDirty = true;
  throttledUpdateUnitList();
}

setInterval(() => {
  const now = Date.now();
  Object.keys(entityState).forEach((uid) => {
    if (entityState[uid].staleAt && now > entityState[uid].staleAt) removeEntity(uid);
  });
}, 5000);
