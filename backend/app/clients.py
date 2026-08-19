#!/usr/bin/env python3
# clients.py - per-user TAK client pool for the multiuser refactor.
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import logging

from .tak_client import Identity, TAKClient

logger = logging.getLogger("tak-webview.clients")


class ClientPool:
    """Owns one TAKClient per (server, username).

    Keyed by (server, username) from day one so multiserver support only
    needs the capacity caps; with the current single pinned server there is
    at most one client per user.
    """

    def __init__(self) -> None:
        self._clients: dict[tuple[str, str], TAKClient] = {}

    def client(self, server: str, username: str, identity: Identity) -> TAKClient:
        """Return (creating on demand) the client for a user.

        The identity is refreshed on every call so a config change or a
        different active server is picked up.
        """
        key = (server, username)
        existing = self._clients.get(key)
        if existing is not None:
            existing.identity = identity
            return existing
        client = TAKClient(identity=identity)
        client.on_cot = client._broadcast_if_needed
        self._clients[key] = client
        logger.info("Created TAK client for user '%s' on %s", username, server)
        return client

    def client_for(self, username: str) -> TAKClient | None:
        """The first client for a username (single-server: the only one)."""
        for (_server, uname), client in self._clients.items():
            if uname == username:
                return client
        return None

    def is_running(self, username: str) -> bool:
        client = self.client_for(username)
        return bool(client and client.is_running)

    async def stop_user(self, username: str) -> None:
        """Stop every client belonging to one user."""
        for key in [k for k in self._clients if k[1] == username]:
            client = self._clients.pop(key)
            logger.info("Stopping TAK client for user '%s'", username)
            await client.stop()

    async def stop_all(self) -> None:
        """Stop every client (app shutdown / install-wide wipe)."""
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            await client.stop()
