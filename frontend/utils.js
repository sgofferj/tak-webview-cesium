// utils.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import { Color } from "cesium";

// CoT Type to MIL-STD-2525 SIDC mapping
export function cotToSidc(type) {
  if (!type) return "u-u-g-u---------";
  const et = type.split("-");
  let affil = et[1] || "u";
  if (affil.includes(".")) affil = "n";
  return [
    "s",
    affil.toLowerCase(),
    (et[2] || "G").toLowerCase(),
    "-",
    (et[3] || "-").toLowerCase(),
    (et[4] || "-").toLowerCase(),
    (et[5] || "-").toLowerCase(),
    (et[6] || "-").toLowerCase(),
    (et[7] || "-").toLowerCase(),
    (et[8] || "-").toLowerCase(),
    "-",
    "-",
  ].join("");
}

export const affilMap = (i18n) => ({
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

export function getAffiliationColor(type) {
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

export function getSquawkLabel(squawk, i18n) {
  if (!squawk) return null;
  const s = squawk.toString();
  if (s === "7500") return i18n.squawk7500 || "HIJACK";
  if (s === "7600") return i18n.squawk7600 || "RADIO FAILURE";
  if (s === "7700") return i18n.squawk7700 || "EMERGENCY";
  return null;
}

// Calculate destination point from start point, bearing and distance
export function getDestination(lon, lat, bearing, distance) {
  const R = 6371000; // Earth's radius in meters
  const brng = (bearing * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distance / R) +
      Math.cos(lat1) * Math.sin(distance / R) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(distance / R) * Math.cos(lat1),
      Math.cos(distance / R) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lon: (lon2 * 180) / Math.PI,
    lat: (lat2 * 180) / Math.PI,
  };
}

export function throttle(func, limit) {
  let inThrottle;
  return function () {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// Google Material Symbols SVG Paths (960x960 coordinate system)
export const GOOGLE_ICON_PATHS = {
  navigation: "M12,2L4.5,20.29L5.21,21L12,18L18.79,21L19.5,20.29L12,2Z",
  triangle: "M12,2 L22,22 L2,22 Z",
};

// Render Google Icon to Canvas
export function renderGoogleIcon(
  iconName,
  color,
  size = 32,
  noBackground = false,
  border = false,
) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const pathData = GOOGLE_ICON_PATHS[iconName] || GOOGLE_ICON_PATHS.navigation;

  if (!noBackground) {
    ctx.fillStyle = "rgba(20, 20, 20, 0.85)";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color || "white";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  const p = new Path2D(pathData);
  const isLargeCoords = pathData.includes("-") || pathData.startsWith("m");
  const viewboxSize = isLargeCoords ? 960 : 24;
  const iconScale = (size * 0.65) / viewboxSize;

  ctx.save();
  if (isLargeCoords) {
    ctx.translate(size / 2, size / 2);
    ctx.scale(iconScale, iconScale);
    ctx.translate(-480, 480);
  } else {
    const offset = (size - 24 * iconScale) / 2;
    ctx.translate(offset, offset);
    ctx.scale(iconScale, iconScale);
  }

  // Draw border
  if (border) {
    ctx.strokeStyle = "rgba(50, 50, 50, 1)";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.stroke(p);
  }

  ctx.fillStyle = color || "white";
  ctx.fill(p);
  ctx.restore();
  return canvas;
}
