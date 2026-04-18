// utils.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import { Color } from "cesium";
import mgrs from "mgrs";

// CoT Type to MIL-STD-2525 SIDC mapping
export function cotToSidc(type) {
  if (!type) return "SUGP-----------";
  const et = type.split("-");
  let affil = (et[1] || "U").toUpperCase();
  if (affil.includes(".")) affil = "N";

  let dim = (et[2] || "G").toUpperCase();

  // Standardize Dimension
  if (!["P", "A", "G", "S", "U", "F"].includes(dim)) dim = "G";

  // Position 1: Scheme (S = Warfighting)
  // Position 2: Identity
  // Position 3: Battle Dimension
  // Position 4: Status (P = Present)
  let sidc = "S" + affil + dim + "P";

  // Position 5-10: Function Code (Mapping from et[3..8])
  for (let i = 3; i <= 8; i++) {
    const part = et[i] || "-";
    sidc += part.toUpperCase().substring(0, 1);
  }

  // Pad to 15 chars
  while (sidc.length < 15) sidc += "-";

  return sidc.substring(0, 15);
}

/**
 * Cleans ATAK-style SIDC strings for milsymbol.js
 * Handles wildcards (*), the SOF dimension (F), and ensures 15 chars.
 */
export function cleanSIDC2525C(sidc) {
  if (!sidc) return "SUGP------*****"; // Fallback to Unknown

  // 1. Force uppercase and convert to array for manipulation
  let cleaned = sidc.toUpperCase().split("");

  // 2. Ensure we are exactly 15 characters (pad with dashes if too short)
  while (cleaned.length < 15) cleaned.push("-");
  if (cleaned.length > 15) cleaned = cleaned.slice(0, 15);

  // 3. Handle specific positions
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "*") {
      switch (i) {
        case 0:
          cleaned[i] = "S";
          break; // Scheme: Warfighting
        case 1:
          cleaned[i] = "U";
          break; // Affiliation: Unknown
        case 2:
          cleaned[i] = "G";
          break; // Dimension: Default to Ground
        case 3:
          cleaned[i] = "P";
          break; // Status: Present (Crucial for rendering)
        default:
          cleaned[i] = "-";
          break; // Modifiers/Country: Null
      }
    }
  }

  // 4. SOF Logic Check:
  // If Position 3 is 'F' (SOF), ensure Position 1 and 2 aren't wildcards.
  // Milsymbol handles 'F' in pos 3 as long as the status (pos 4) is valid.
  if (cleaned[2] === "F" && cleaned[3] === "-") {
    cleaned[3] = "P";
  }

  return cleaned.join("");
}

export function getMGRS(lon, lat) {
  try {
    return mgrs.forward([lon, lat]);
  } catch {
    return "N/A";
  }
}

export const affilMap = (i18n) => ({
  f: i18n.affiliationFriendly,
  a: i18n.affiliationFriendly,
  h: i18n.affiliationHostile,
  s: i18n.affiliationSuspect,
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
