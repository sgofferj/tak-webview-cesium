#!/usr/bin/env python3
# groups.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

"""TAK Server channel (group) subscription proxy.

TAK Server 5.x exposes the classic file/LDAP auth groups to users as
selectable "channels". The wire protocol is the Marti group REST API:

- GET  /Marti/api/groups/user?username=<name>   - entitlements + state
- PUT  /Marti/api/groups/active                 - set active group set

Verified live against TAK Server 5.7:
- Groups are directional (IN = receive, OUT = send); each user sees one
  entitlement entry per (group, direction) pair, with an independent
  `active` flag.
- PUT /groups/active takes a JSON array of {"name", "direction"} objects
  and is ABSOLUTE: the body must contain the complete desired active set,
  anything omitted becomes inactive.

This module talks to the TAK server with the logged-in user's own client
certificate so the server applies the user's real entitlements.
"""

import logging
from typing import Any

import httpx

from .config import settings
from .tak_client import build_ssl_context_for_user

logger = logging.getLogger("tak-webview.groups")

_MARTI_TIMEOUT = 10.0


def _marti_base_url(server: str) -> str:
    return f"https://{server}:{settings.tak_api_port}/Marti/api"


async def _marti_request(  # pylint: disable=too-many-arguments
    method: str,
    server: str,
    username: str,
    path: str,
    *,
    params: dict[str, str] | None = None,
    json_body: Any = None,
) -> httpx.Response:
    """Perform one mTLS request against the Marti API as the given user."""
    ctx = build_ssl_context_for_user(username)
    url = f"{_marti_base_url(server)}{path}"
    async with httpx.AsyncClient(verify=ctx, timeout=_MARTI_TIMEOUT) as client:
        return await client.request(method, url, params=params, json=json_body)


async def get_group_entitlements(server: str, username: str) -> list[dict[str, Any]]:
    """Fetch the user's group entitlements from the TAK server.

    Returns the raw list of Group entries (one per name/direction pair).
    """
    resp = await _marti_request(
        "GET",
        server,
        username,
        "/groups/user",
        params={"username": username},
    )
    resp.raise_for_status()
    data = resp.json().get("data")
    if not isinstance(data, list):
        return []
    return [g for g in data if isinstance(g, dict) and g.get("name")]


def channels_from_entitlements(
    entitlements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Reduce (group, direction) entitlements to a flat channel list.

    A checkbox represents both IN and OUT: a channel counts as subscribed
    only when every available direction is currently active.
    """
    by_name: dict[str, list[dict[str, Any]]] = {}
    for g in entitlements:
        by_name.setdefault(str(g["name"]).strip(), []).append(g)

    channels = [
        {
            "name": name,
            "subscribed": all(bool(e.get("active")) for e in entries),
        }
        for name, entries in sorted(by_name.items())
    ]
    return channels


async def get_channels(server: str, username: str) -> list[dict[str, Any]]:
    """Available channels for the user with their subscription state."""
    entitlements = await get_group_entitlements(server, username)
    return channels_from_entitlements(entitlements)


async def set_subscribed_channels(server: str, username: str, names: set[str]) -> None:
    """Subscribe/unsubscribe channels by name (controls IN and OUT).

    Because PUT /groups/active is absolute, this fetches the current
    entitlements first and submits the desired active subset of them.
    Entries for omitted names become inactive on the server.
    """
    entitlements = await get_group_entitlements(server, username)
    body = [
        {"name": g["name"], "direction": g["direction"]}
        for g in entitlements
        if str(g["name"]).strip() in names
    ]
    resp = await _marti_request(
        "PUT",
        server,
        username,
        "/groups/active",
        json_body=body,
    )
    resp.raise_for_status()
