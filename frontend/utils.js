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

// Google Material Symbols SVG Paths (960x960 coordinate system)
export const GOOGLE_ICON_PATHS = {
  fire: "M240-400q0 52 21 98.5t60 81.5q-1-5-1-9v-9q0-32 12-60t35-51l113-111 113 111q23 23 35 51t12 60v9q0 4-1 9 39-35 60-81.5t21-98.5q0-50-18.5-94.5T648-574q-20 13-42 19.5t-45 6.5q-62 0-107.5-41T401-690q-39 33-69 68.5t-50.5 72Q261-513 250.5-475T240-400Zm240 52-57 56q-11 11-17 25t-6 29q0 32 23.5 55t56.5 23q33 0 56.5-23t23.5-55q0-16-6-29.5T537-292l-57-56Zm0-492v132q0 34 23.5 57t57.5 23q18 0 33.5-7.5T622-658l18-22q74 42 117 117t43 163q0 134-93 227T480-80q-134 0-227-93t-93-227q0-129 86.5-245T480-840Z",
  sunny:
    "M440-760v-160h80v160h-80Zm266 110-55-55 112-115 56 57-113 113Zm54 210v-80h160v80H760ZM440-40v-160h80v160h-80ZM254-652 140-763l57-56 113 113-56 54Zm508 512L651-255l54-54 114 110-57 59ZM40-440v-80h160v80H40Zm157 300-56-57 112-112 29 27 29 28-114 114Zm113-170q-70-70-70-170t70-170q70-70 170-70t170 70q70 70 70 170t-70 170q-70 70-170 70t-170-70Zm283-57q47-47 47-113t-47-113q-47-47-113-47t-113 47q-47 47-47 113t47 113q47 47 113 47t113-47ZM480-480Z",
  earthquake:
    "M361-80q-14 0-24.5-7.5T322-108L220-440H80v-80h170q13 0 23.5 7.5T288-492l66 215 127-571q3-14 14-23t25-9q14 0 25 8.5t14 22.5l87 376 56-179q4-13 14.5-20.5T740-680q13 0 23 7t15 19l50 134h52v80h-80q-13 0-23-7t-15-19l-19-51-65 209q-4 13-15 21t-25 7q-14-1-24-9.5T601-311l-81-348-121 548q-3 14-13.5 22T361-80Z",
  cyclone:
    "M480-320q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm0-80q33 0 56.5-23.5T560-480q0-33-23.5-56.5T480-560q-33 0-56.5 23.5T400-480q0 33 23.5 56.5T480-400ZM661-80q18-56 27-100t14-70q-43 42-100 66t-122 24q-136 0-238.5-18.5T80-214v-85q56 18 100 27t70 14q-42-43-66-100t-24-122q0-137 18.5-239T214-880h85q-18 56-27.5 100T258-710q43-42 100-66t122-24q137 0 239 18.5T880-746v85q-56-18-100-27.5T710-702q42 43 66 100t24 122q0 137-18.5 239T746-80h-85Zm-11-230q70-70 70-170t-70-170q-70-70-170-70t-170 70q-70 70-70 170t70 170q70 70 170 70t170-70Z",
  flood:
    "M80-80v-80q38 0 56.5-20t77.5-20q59 0 77 20t56 20q38 0 56-20t77-20q57 0 77.5 20t56.5 20q38 0 56-20t77-20q59 0 77 20t56 20v80q-58 0-77-20t-56-20q-37 0-56 20t-77 20q-58 0-77.5-20T480-120q-38 0-56 20t-77 20q-59 0-77-20t-56-20q-37 0-56 20T80-80Zm267-180q-57 0-77-20t-56-20q-35 0-56 20t-78 20v-80q38 0 56-20t77-20q6 0 12 .5t11 1.5l-38-140-55 72-63-50 311-384 461 176-29 75-84-34 81 301q14 8 27.5 15t32.5 7v80q-57-1-77-20.5T747-300q-38 0-56 20t-77 20q-57 0-77.5-20T480-300q-38 0-56 20t-77 20Zm0-80q30 0 46.5-14t50.5-22l-37-136 155-41 56 212q31-2 49-18.5t65-19.5l-86-321-229-84-157 188 69 254q4 1 8.5 1.5t9.5.5Zm149-222Z",
  volcano:
    "m80-80 160-360h120l80-200h280L880-80H80Zm123-80h571L660-560H494l-80 200H292l-89 200Zm317-600v-160h80v160h-80Zm181 75-56-56 113-113 57 56-114 113Zm-282 0L306-798l56-57 113 114-56 56Zm355 525H203h571Z",
};

// Render Google Icon to Canvas
export function renderGoogleIcon(iconName, color, size = 32) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const pathData = GOOGLE_ICON_PATHS[iconName] || GOOGLE_ICON_PATHS.fire;
  ctx.fillStyle = "rgba(20, 20, 20, 0.85)";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color || "white";
  ctx.lineWidth = 2.5;
  ctx.stroke();
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
  ctx.fillStyle = color || "white";
  ctx.fill(p);
  ctx.restore();
  return canvas;
}
