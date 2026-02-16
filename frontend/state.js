import {
  Cartesian2,
  Cartesian3,
  Color,
  VerticalOrigin,
  HorizontalOrigin,
  LabelStyle,
  DistanceDisplayCondition,
  CallbackProperty,
  PolylineGlowMaterialProperty,
  ColorMaterialProperty,
  HeadingPitchRange,
  Math as CesiumMath,
  Ellipsoid,
} from "cesium";
import ms from "milsymbol";
import { i18n, appConfig } from "./config.js";
import { viewer } from "./viewer.js";
import {
  cotToSidc,
  getAffiliationColor,
  getSquawkLabel,
  affilMap,
  throttle,
} from "./utils.js";

export const entityState = {};
export let currentFilter = "";
export let currentAffiliationFilter = "all";
export let showAllTrails = false;
export const collapsedStates = new Set([
  "incidents",
  "aircraft",
  "vessels",
  "other",
]);

export function setFilters(filter, affiliation) {
  if (filter !== undefined) currentFilter = filter.toLowerCase();
  if (affiliation !== undefined) currentAffiliationFilter = affiliation;
  applyFilter();
}

export function setShowAllTrails(val) {
  showAllTrails = val;
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
  });
}

export function calculateVisibility(data) {
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
  Object.keys(entityState).forEach((uid) => {
    const state = entityState[uid];
    state.entity.show = calculateVisibility(state.lastData);
    if (state.trailEntity) {
      state.trailEntity.show = calculateTrailVisibility(uid);
    }
  });
  throttledUpdateUnitList();
}

export function createDescription(data) {
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

export function updateUnitListUI() {
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

export const throttledUpdateUnitList = throttle(updateUnitListUI, 1000);

window.toggleCollapse = function (key) {
  if (collapsedStates.has(key)) {
    collapsedStates.delete(key);
  } else {
    collapsedStates.add(key);
  }
  updateUnitListUI();
};

window.zoomToUnit = function (uid) {
  const state = entityState[uid];
  if (state) {
    viewer.selectedEntity = state.entity;
    viewer.flyTo(state.entity, {
      offset: new HeadingPitchRange(0, -Math.PI / 2, 200000),
    });
  }
};

export function updateEntity(data) {
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
  let iconsetUrl = null;

  if (iconsetpath) {
    const parts = iconsetpath.split("/").filter((p) => p.length > 0);
    const setUid = parts.shift();
    const iconFile = parts.join("/");

    if (window.availableIconsets && window.availableIconsets[setUid]) {
      const set = window.availableIconsets[setUid];
      if (iconFile) {
        iconsetUrl = encodeURI(`${set.url_path}/${iconFile}`);
      } else if (set.type_map && set.type_map[type]) {
        iconsetUrl = encodeURI(`${set.url_path}/${set.type_map[type]}`);
      } else if (setUid === "66f14976-4b62-4023-8edb-d8d2ebeaa336") {
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
      iconsetUrl = iconsetpath.startsWith("/")
        ? iconsetpath
        : `/iconsets/${iconsetpath}`;
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
  const camHeight = viewer.camera.positionCartographic.height;
  const showAltOnIcon = camHeight < 200000 && type.split("-")[2] === "A";

  const stateKey = iconsetUrl
    ? `icon-${iconsetUrl}-${rgbColor}`
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
        state.entity.billboard.image = iconsetUrl;
        state.entity.billboard.width = 28;
        state.entity.billboard.height = 28;
        state.entity.billboard.pixelOffset = new Cartesian2(0, 0);
        state.lastIconUrl = iconsetUrl;
        iconCanvas = null;
        // TINT: Only if color was provided in COT
        state.entity.billboard.color = color ? cesiumColor : Color.WHITE;
      } else {
        const isAircraft = type.split("-")[2] === "A";
        const symbolOptions = { size: 21, padding: 5 };
        const label = getSquawkLabel(squawk, i18n);
        if (label) symbolOptions.staffComments = label;
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
        // NO TINT for milsymbol (color is in canvas)
        state.entity.billboard.color = Color.WHITE;
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
      state.lastStateKey = stateKey;
      state.lastRgbColor = rgbColor;
    }
    state.staleAt = stale ? new Date(stale).getTime() : null;

    const squawkLabel = getSquawkLabel(squawk, i18n);
    if (squawkLabel) {
      state.entity.label.text = `${callsign}\n[${squawkLabel}]`;
      state.entity.label.fillColor = Color.RED;
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

    if (
      course !== null &&
      course !== undefined &&
      iconsetUrl &&
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
        // Set initial color based on data
        color: iconsetUrl ? (color ? cesiumColor : Color.WHITE) : Color.WHITE,
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
    } else {
      const isAircraft = type.split("-")[2] === "A";
      const symbolOptions = { size: 21, padding: 5 };
      const label = getSquawkLabel(squawk, i18n);
      if (label) symbolOptions.staffComments = label;
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
      show: calculateTrailVisibility(uid),
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
  throttledUpdateUnitList();
}

export function removeEntity(uid) {
  const state = entityState[uid];
  if (!state) return;
  if (state.entity) viewer.entities.remove(state.entity);
  if (state.trailEntity) viewer.entities.remove(state.trailEntity);
  if (state.flashingCircle) viewer.entities.remove(state.flashingCircle);
  if (state.directionArrow) viewer.entities.remove(state.directionArrow);
  delete entityState[uid];
  throttledUpdateUnitList();
}

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
