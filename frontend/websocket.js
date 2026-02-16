import { updateEntity } from "./state.js";

export function startWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsHost = import.meta.env.VITE_WS_HOST || window.location.host;
  const wsPath = import.meta.env.VITE_WS_PATH || "/ws";
  const wsUrl = `${protocol}//${wsHost}${wsPath}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to Backend WebSocket");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
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
  };

  return ws;
}
