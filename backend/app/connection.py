#!/usr/bin/env python3
# connection.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

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

    async def broadcast(self, message: str) -> None:
        # Create a copy of the list to avoid issues with concurrent modification
        for connection in self.active_connections[:]:
            try:
                await connection.send_text(message)
            except Exception:
                # If sending fails, assume the connection is dead
                self.active_connections.remove(connection)
                logger.debug(
                    "Send failed, removed connection. "
                    f"Active: {len(self.active_connections)}"
                )


manager = ConnectionManager()
