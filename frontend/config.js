// config.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

export const i18n = {};
export const appConfig = { center_alert: false };

export async function loadConfig() {
  try {
    const response = await fetch("/config");
    if (response.ok) {
      const data = await response.json();
      console.log("App Config Received:", data);
      // Mutate the object to ensure live bindings in all modules
      Object.assign(appConfig, data);
      window.availableIconsets = appConfig.iconsets || {};

      if (appConfig.logo) {
        const logoImg = document.getElementById("brandingLogo");
        if (logoImg) {
          logoImg.src = "/logo";
          logoImg.classList.remove("hidden");
          const pos = appConfig.logo_position || "bottom_right";
          logoImg.classList.add(`logo-${pos}`);
        }
      }
    }
  } catch (e) {
    console.warn("Failed to load server config, using defaults.", e);
  }
}

export async function loadTranslations() {
  const lang = (navigator.language || navigator.userLanguage).split("-")[0];
  const fetchLang = async (l) => {
    const response = await fetch(`/locales/${l}.json`);
    if (!response.ok) throw new Error(`Lang ${l} not found`);
    return await response.json();
  };

  try {
    const translations = await fetchLang(lang);
    Object.assign(i18n, translations);
  } catch (e) {
    console.warn(`${e.message}, falling back to English.`);
    try {
      const translations = await fetchLang("en");
      Object.assign(i18n, translations);
    } catch (e2) {
      console.error("Critical: English translation also failed.", e2);
      Object.assign(i18n, {
        title: "TAK Cesium Map",
        filterPlaceholder: "Filter...",
        terrainLabel: "Terrain",
      });
    }
  }
  applyStaticTranslations();
}

function applyStaticTranslations() {
  document.title = appConfig.app_title || i18n.title;
  const elements = {
    filterInput: (el) =>
      (el.placeholder = i18n.filterPlaceholder || "Filter..."),
    clearFilter: (el) => (el.innerText = i18n.clearButton || "Clear"),
    zoomToAll: (el) => {
      el.innerText = i18n.zoomToAllButton || "Zoom to All";
      el.title = i18n.zoomToAllTitle || "Zoom to all filtered entities";
    },
    resetView: (el) => {
      el.innerText = i18n.resetViewButton || "Reset View";
      el.title = i18n.resetViewTitle || "Reset to default view";
    },
    toggleTrails: (el) => {
      el.innerText = i18n.trailsButtonOff || "Trails Off";
      el.title = i18n.trailsTitle || "Toggle unit trails";
    },
    toggleUnitList: (el) => {
      el.title = i18n.unitsTitle || "Toggle unit list";
    },
    sidebarHeaderView: (el) =>
      (el.innerText = i18n.sidebarHeaderView || "View"),
    sidebarHeaderFilter: (el) =>
      (el.innerText = i18n.sidebarHeaderFilter || "Filter"),
    sidebarHeaderTracks: (el) =>
      (el.innerText = i18n.sidebarHeaderTracks || "Active Tracks"),
    sidebarHeaderStaff: (el) =>
      (el.innerText = i18n.sidebarHeaderStaff || "Staff Comments"),
    labelShowCallsigns: (el) =>
      (el.innerText = i18n.labelShowCallsigns || "Show callsigns"),
    labelAuthChoice: (el) =>
      (el.innerText =
        i18n.labelAuthChoice ||
        "Please choose how to connect to the TAK network."),
    labelEnroll: (el) => (el.innerText = i18n.labelEnroll || "Enrollment"),
    labelUploadCert: (el) =>
      (el.innerText = i18n.labelUploadCert || "Certificate Upload"),
    labelEnrollDesc: (el) =>
      (el.innerText =
        i18n.labelEnrollDesc || "Please enroll to access the TAK network."),
    labelUploadDesc: (el) =>
      (el.innerText = i18n.labelUploadDesc || "Upload your .p12 certificate."),
    labelInsecurePass: (el) =>
      (el.innerText =
        i18n.labelInsecurePass ||
        "Your certificate password is insecure. Please set a new strong password (min 8 chars)."),
    labelLoginDesc: (el) =>
      (el.innerText = i18n.labelLoginDesc || "Authenticated access required."),
    labelImportedCertFor: (el) =>
      (el.innerText = i18n.labelImportedCertFor || "Imported certificate for:"),
    enrollButton: (el) => (el.innerText = i18n.labelEnroll || "Enroll"),
    uploadButton: (el) =>
      (el.innerText = i18n.uploadButton || "Upload & Connect"),
    loginButton: (el) => (el.innerText = i18n.loginButton || "Login"),
    showInfo: (el) => {
      el.innerText = "ⓘ " + (i18n.infoTitle || "Info");
    },
  };

  for (const [id, action] of Object.entries(elements)) {
    const el = document.getElementById(id);
    if (el) action(el);
  }

  const affilSelect = document.getElementById("affiliationFilter");
  if (affilSelect) {
    const texts = [
      i18n.affiliationFriendly || "Friendly",
      i18n.affiliationHostile || "Hostile",
      i18n.affiliationSuspect || "Suspect",
      i18n.affiliationNeutral || "Neutral",
      i18n.affiliationUnknown || "Unknown",
    ];
    for (let i = 0; i < texts.length; i++) {
      if (affilSelect.options[i]) affilSelect.options[i].text = texts[i];
    }
  }
}
