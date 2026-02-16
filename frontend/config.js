export let i18n = {};
export let appConfig = { center_alert: false };

export async function loadConfig() {
  try {
    const response = await fetch("/config");
    if (response.ok) {
      appConfig = await response.json();
      console.log("App Config Loaded:", appConfig);
      window.availableIconsets = appConfig.iconsets || {};
    }
  } catch (e) {
    console.warn("Failed to load server config, using defaults.");
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
  document.title = appConfig.app_title || i18n.title;
  const elements = {
    filterInput: (el) => (el.placeholder = i18n.filterPlaceholder),
    clearFilter: (el) => (el.innerText = i18n.clearButton),
    resetView: (el) => {
      el.innerText = i18n.resetViewButton;
      el.title = i18n.resetViewTitle;
    },
    toggleTrails: (el) => {
      el.innerText = i18n.trailsButtonOff;
      el.title = i18n.trailsTitle;
    },
    toggleUnitList: (el) => {
      el.innerText = i18n.unitsButton;
      el.title = i18n.unitsTitle;
    },
    unitListHeader: (el) => (el.innerText = i18n.activeUnitsHeader),
  };

  for (const [id, action] of Object.entries(elements)) {
    const el = document.getElementById(id);
    if (el) action(el);
  }

  const affilSelect = document.getElementById("affiliationFilter");
  if (affilSelect) {
    const texts = [
      i18n.allAffiliations,
      i18n.affiliationFriendly,
      i18n.affiliationHostile,
      i18n.affiliationNeutral,
      i18n.affiliationUnknown,
    ];
    for (let i = 0; i < texts.length; i++) {
      if (affilSelect.options[i]) affilSelect.options[i].text = texts[i];
    }
  }
}
