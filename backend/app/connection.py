#!/usr/bin/env python3
# connection.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import asyncio
import logging

from fastapi import WebSocket

logger = logging.getLogger("tak-webview.connection")


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.debug(f"Client connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.debug(
                f"Client disconnected. Active: {len(self.active_connections)}"
            )

    async def broadcast(self, message: str | bytes) -> None:
        if not self.active_connections:
            return
        await asyncio.gather(
            *(self._send_safe(conn, message) for conn in self.active_connections)
        )

    async def _send_safe(self, websocket: WebSocket, message: str | bytes) -> None:
        try:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)
        except Exception:
            # Connection likely closed, will be handled by disconnect or manual removal
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
                logger.debug(
                    "Send failed, removed connection. "
                    f"Active: {len(self.active_connections)}"
                )


manager = ConnectionManager()
