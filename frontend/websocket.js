// websocket.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import { decode } from "@msgpack/msgpack";
import { updateEntity } from "./state.js";
import { checkAuth } from "./main.js";

let pulseTimeout = null;
function triggerPulse() {
  const dot = document.getElementById("statusPulse");
  if (!dot) return;
  dot.classList.add("pulse-active");
  if (pulseTimeout) clearTimeout(pulseTimeout);
  pulseTimeout = setTimeout(() => {
    dot.classList.remove("pulse-active");
    pulseTimeout = null;
  }, 100);
}

export function startWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket Connection Open");
    const conn = document.getElementById("statusConnection");
    if (conn) {
      conn.innerText = "Connected";
      conn.classList.add("conn-online");
    }
  };

  ws.onmessage = (event) => {
    try {
      let data;
      if (event.data instanceof ArrayBuffer) {
        data = decode(new Uint8Array(event.data));
      } else {
        data = JSON.parse(event.data);
      }
      triggerPulse();
      updateEntity(data);
    } catch (e) {
      console.error("Error parsing WS message", e);
    }
  };

  ws.onerror = (error) => {
    console.error("WebSocket Error:", error);
    checkAuth(); // Check if session is still valid if connection fails
  };

  ws.onclose = (event) => {
    console.log(`WebSocket Connection Closed: ${event.code} ${event.reason}`);
    const conn = document.getElementById("statusConnection");
    if (conn) {
      conn.innerText = "Disconnected";
      conn.classList.remove("conn-online");
    }

    if (event.code === 4001) {
      console.warn("WebSocket unauthorized, showing login overlay.");
      checkAuth();
      return; // Don't auto-reconnect if unauthorized
    }

    // Reconnect after 5s
    setTimeout(startWebSocket, 5000);
  };
}
