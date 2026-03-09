// websocket.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import { decode } from "@msgpack/msgpack";
import { updateEntity } from "./state.js";

export function startWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsHost = import.meta.env.VITE_WS_HOST || window.location.host;
  const wsPath = import.meta.env.VITE_WS_PATH || "/ws";
  const wsUrl = `${protocol}//${wsHost}${wsPath}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("Connected to Backend WebSocket");
    const conn = document.getElementById("statusConnection");
    if (conn) {
      conn.innerText = "Online";
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
      updateEntity(data);
    } catch (e) {
      console.error("Error parsing WS message", e);
    }
  };

  ws.onerror = (error) => {
    console.error("WebSocket Error", error);
  };

  ws.onclose = () => {
    console.log("WebSocket Connection Closed");
    const conn = document.getElementById("statusConnection");
    if (conn) {
      conn.innerText = "Disconnected";
      conn.classList.remove("conn-online");
    }
    // Reconnect after 5s
    setTimeout(startWebSocket, 5000);
  };

  return ws;
}
