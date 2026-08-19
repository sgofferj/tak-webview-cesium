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

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("tak-webview.connection")


class ConnectionManager:
    """Websocket hub that routes payloads to the right users.

    Each connected websocket is tagged with its authenticated username so a
    TAK client's SA/chat stream only reaches that user's tabs (multiuser
    isolation). A message sent with username=None is broadcast to everyone,
    which is only used for legacy/no-user paths.
    """

    def __init__(self) -> None:
        self._connections: dict[WebSocket, str] = {}  # ws -> username

    async def connect(self, websocket: WebSocket, username: str) -> None:
        await websocket.accept()
        self._connections[websocket] = username
        client_host = websocket.client.host if websocket.client else "unknown"
        logger.info(
            f"Client {client_host} connected as {username}. "
            f"Active: {len(self._connections)}"
        )

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self._connections:
            del self._connections[websocket]
            logger.debug(f"Client disconnected. Active: {len(self._connections)}")

    def count_for(self, username: str) -> int:
        """Live websocket count for one user (across all their sessions)."""
        return sum(1 for user in self._connections.values() if user == username)

    async def broadcast(
        self, message: str | bytes, username: str | None = None
    ) -> None:
        """Send to all websockets of `username`, or to everyone when None."""
        targets = [
            ws
            for ws, user in self._connections.items()
            if username is None or user == username
        ]
        if not targets:
            return
        await asyncio.gather(*(self._send_safe(conn, message) for conn in targets))

    async def _send_safe(self, websocket: WebSocket, message: str | bytes) -> None:
        try:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)
        except (RuntimeError, AttributeError, WebSocketDisconnect):
            # Connection likely closed, will be handled by disconnect or manual removal
            if websocket in self._connections:
                del self._connections[websocket]
                logger.debug(
                    "Send failed, removed connection. "
                    f"Active: {len(self._connections)}"
                )


class SessionTracker:
    """Tracks authenticated web sessions, their users, and live websockets.

    Maps sid -> username (authoritative, RAM only) so every authenticated
    request/websocket can resolve which user it belongs to. Also counts live
    websockets per sid; a session drops out when its last tab closes.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, str] = {}  # sid -> username
        self._ws: dict[str, int] = {}  # sid -> live websocket count
        self._users: dict[str, set[str]] = {}  # username -> set of sids

    def register(self, sid: str, username: str) -> None:
        """Register a logged-in session (no live websocket yet)."""
        self._sessions[sid] = username
        self._users.setdefault(username, set()).add(sid)

    def unregister(self, sid: str) -> str | None:
        """Remove a session on logout; returns its username."""
        username = self._sessions.pop(sid, None)
        if username:
            sids = self._users.get(username)
            if sids:
                sids.discard(sid)
                if not sids:
                    self._users.pop(username, None)
        return username

    def username_for(self, sid: str | None) -> str | None:
        if not sid:
            return None
        return self._sessions.get(sid)

    def sessions_for(self, username: str) -> set[str]:
        return self._users.get(username, set())

    def reset(self) -> None:
        """Forget all sessions (logout with an unattributable sid)."""
        self._sessions.clear()
        self._ws.clear()
        self._users.clear()

    def ws_opened(self, sid: str) -> None:
        """A websocket of this session came up."""
        self._ws[sid] = self._ws.get(sid, 0) + 1

    def ws_closed(self, sid: str) -> None:
        """A websocket of this session went down."""
        count = self._ws.get(sid, 0)
        if count <= 1:
            self._ws.pop(sid, None)
        else:
            self._ws[sid] = count - 1

    @property
    def active(self) -> bool:
        """True while at least one websocket from any session is live."""
        return any(count > 0 for count in self._ws.values())


manager = ConnectionManager()
tracker = SessionTracker()
