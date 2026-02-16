import { Cartesian3 } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { loadConfig, loadTranslations, i18n } from "./config.js";
import { initViewer, viewer } from "./viewer.js";
import {
  entityState,
  showAllTrails,
  followedEntityUid,
  setFilters,
  setShowAllTrails,
  setFollowedEntity,
  calculateTrailVisibility,
  throttledUpdateUnitList,
} from "./state.js";
import { startWebSocket } from "./websocket.js";

async function init() {
  await loadConfig();
  await loadTranslations();
  await initViewer();
  setupEvents();
  startWebSocket();
}

function setupEvents() {
  viewer.selectedEntityChanged.addEventListener((entity) => {
    const infoBox = document.querySelector(".cesium-infoBox");
    if (infoBox) {
      infoBox.classList.remove("emergency-active");
    }
    Object.keys(entityState).forEach((uid) => {
      const state = entityState[uid];
      if (state.trailEntity) {
        state.trailEntity.show = calculateTrailVisibility(uid);
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

  // Track if user manually breaks tracking
  viewer.scene.postRender.addEventListener(() => {
    if (followedEntityUid && !viewer.trackedEntity) {
      setFollowedEntity(null);
    }
  });

  document.getElementById("toggleFollow").addEventListener("click", () => {
    if (followedEntityUid) {
      setFollowedEntity(null);
    } else if (viewer.selectedEntity) {
      setFollowedEntity(viewer.selectedEntity.id);
    }
  });

  document.getElementById("filterInput").addEventListener("input", (e) => {
    setFilters(e.target.value, undefined);
  });
  document
    .getElementById("affiliationFilter")
    .addEventListener("change", (e) => {
      setFilters(undefined, e.target.value);
    });
  document.getElementById("clearFilter").addEventListener("click", () => {
    document.getElementById("filterInput").value = "";
    document.getElementById("affiliationFilter").value = "all";
    setFilters("", "all");
  });
  document.getElementById("resetView").addEventListener("click", () => {
    setFollowedEntity(null);
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
    const newVal = !showAllTrails;
    setShowAllTrails(newVal);
    e.target.innerText = newVal ? i18n.trailsButtonOn : i18n.trailsButtonOff;
  });

  document.getElementById("toggleUnitList").addEventListener("click", () => {
    document.getElementById("unitListPanel").classList.toggle("hidden");
    throttledUpdateUnitList();
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

window.filterByTag = function (tag) {
  const filterInput = document.getElementById("filterInput");
  if (filterInput) {
    filterInput.value = tag;
    setFilters(tag, undefined);
  }
};

init();
