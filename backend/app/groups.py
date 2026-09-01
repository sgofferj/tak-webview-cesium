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

- GET  /Marti/api/groups/all?useCache=true  - entitlements + state
     (``GET /groups/user?username=`` is admin-only and returns 403 for a
      normal user cert — verified live on a TAK Server 5.7 instance;
      ``useCache=false`` only returns the currently active subset, so
      ``true`` is needed for the full catalog)
- PUT  /Marti/api/groups/active              - set active group set

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

    Regular (non-admin) certificates cannot query ``GET /groups/user`` — the
    server answers 403.  The channel list that a normal user is *entitled*
    to is available via ``GET /groups/all?useCache=true`` (verified live
    against a TAK Server 5.7 instance: ``/groups/user`` 403,
    ``/groups/all`` 200; ``useCache=false`` only returns the active subset).
    ``active`` in that response already reflects the user's current
    subscription, so it can be used for both the catalog and the subscribed
    state.  We try ``/groups/all`` first and fall back to the old
    ``/groups/user`` path for backwards compatibility.
    """
    # Primary: the endpoint that works with a normal user cert.
    try:
        resp = await _marti_request(
            "GET",
            server,
            username,
            "/groups/all",
            params={"useCache": "true", "sendLatestSA": "true"},
        )
        resp.raise_for_status()
        data = resp.json().get("data")
        if isinstance(data, list) and data:
            filtered = [g for g in data if isinstance(g, dict) and g.get("name")]
            if filtered:
                return filtered
    except httpx.HTTPStatusError as exc:
        # 403 from the per-user endpoint is expected for non-admins; the
        # ``/groups/all`` fallback already succeeded in that case, so only
        # log when both paths fail.  Fall through to the legacy path.
        if exc.response.status_code not in (403, 404):
            logger.debug("groups/all failed for %s: %s", username, exc)
    except (httpx.HTTPError, RuntimeError, OSError) as exc:
        logger.debug("groups/all failed for %s: %s", username, exc)

    # Legacy/fallback: per-user readback (requires admin on some servers).
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

    The ``/groups/all?useCache=true`` response can contain stale duplicates
    (same name+direction with different ``created`` dates).  The newest entry
    wins, mirroring ``python-takserver-api``'s ``get_channels()`` deduplication.
    """
    # Deduplicate by (name, direction), keeping the newest ``created``.
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for g in entitlements:
        name = str(g.get("name", "")).strip()
        direction = str(g.get("direction", "")).strip().upper()
        if not name or not direction:
            continue
        key = (name, direction)
        created = str(g.get("created") or "")
        existing = latest.get(key)
        if existing is None or created > str(existing.get("created") or ""):
            latest[key] = g

    by_name: dict[str, list[dict[str, Any]]] = {}
    for (name, _direction), entry in latest.items():
        by_name.setdefault(name, []).append(entry)

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
    seen: set[tuple[str, str]] = set()
    body: list[dict[str, str]] = []
    for g in entitlements:
        name = str(g.get("name", "")).strip()
        if name not in names:
            continue
        direction = str(g.get("direction", "")).strip().upper()
        if not direction:
            continue
        key = (name, direction)
        if key in seen:
            continue
        seen.add(key)
        body.append({"name": name, "direction": direction})
    resp = await _marti_request(
        "PUT",
        server,
        username,
        "/groups/active",
        json_body=body,
    )
    resp.raise_for_status()
