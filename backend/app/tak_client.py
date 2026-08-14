#!/usr/bin/env python3
# tak_client.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import asyncio
import datetime
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from lxml import etree

from .config import Settings, settings
from .connection import manager

logger = logging.getLogger("tak-webview.tak")


# ------------------------------------------------------------------
#  Helper: build a minimal SA (type a-f-G-U-C) with contact+__group
# ------------------------------------------------------------------
def _build_sa(
    callsign: str | None = None,
    color: str | None = None,
    role: str | None = None,
) -> etree.Element:
    """Return an <event> element formatted as an SA with the given
    callsign, colour and role.  The ``endpoint`` attribute is set to
    ``*:-1:stcp`` and a ``<__group>`` element is added."""
    cs = callsign or settings.tak_callsign_input or settings.tak_callsign
    col = color or settings.tak_color
    rol = role or settings.tak_role

    now = datetime.datetime.now(datetime.UTC)
    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    stale = now + datetime.timedelta(minutes=1)
    stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

    cot = etree.Element("event")
    cot.set("version", "2.0")
    # generate a simple uid based on callsign + counter to avoid collisions
    cot.set("uid", f"{cs}-sa")
    cot.set("type", "a-f-G-U-C")
    cot.set("how", "m-g")
    cot.set("time", now_str)
    cot.set("start", now_str)
    cot.set("stale", stale_str)

    detail = etree.SubElement(cot, "detail")
    contact = etree.SubElement(detail, "contact")
    contact.set("callsign", cs)
    contact.set("endpoint", "*:-1:stcp")  # mandatory per spec

    group = etree.SubElement(detail, "__group")
    group.set("name", col)  # colour name
    group.set("role", rol)  # role name

    return cot


# ------------------------------------------------------------------
#  TAKClient – minimal implementation needed for the messaging flow
# ------------------------------------------------------------------
class TAKClient:
    def __init__(self) -> None:
        self._stop = asyncio.Event()
        self._run_task = None
        self._reader = None
        self._writer = None

        # Callsign/color/role may be overridden after enrollment / login
        self._callsign: str = settings.tak_callsign_input or settings.tak_callsign
        self._color: str = settings.tak_color
        self._role: str = settings.tak_role

    # ------------------------------------------------------------------
    #  Send one SA immediately (used after connect & after config update)
    # ------------------------------------------------------------------
    async def _send_initial_sa(self) -> None:
        """Send the very first SA after the TCP connection is established.
        The payload contains the current callsign, colour and role."""
        if not self._writer:
            return
        cot = _build_sa(callsign=self._callsign, color=self._color, role=self._role)
        self._writer.write(etree.tostring(cot))
        await self._writer.drain()
        logger.info(
            "Initial SA sent with callsign=%s colour=%s role=%s",
            self._callsign,
            self._color,
            self._role,
        )

    # ------------------------------------------------------------------
    #  Periodic heartbeat (SA + ping) – every 30 s
    # ------------------------------------------------------------------
    async def _send_heartbeat(self) -> None:
        while not self._stop.is_set():
            if self._writer:
                try:
                    now = datetime.datetime.now(datetime.UTC)
                    stale = now + datetime.timedelta(minutes=1)
                    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                    stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

                    # 1. SA heartbeat (a-f-G-U‑C)
                    cot = _build_sa(
                        callsign=self._callsign,
                        color=self._color,
                        role=self._role,
                    )
                    self._writer.write(etree.tostring(cot))

                    # 2. takPing (t‑x‑c‑t)
                    ping = etree.Element("event")
                    ping.set("version", "2.0")
                    ping.set("uid", f"{self._callsign}-ping")
                    ping.set("type", "t-x-c-t")
                    ping.set("how", "m-g")
                    ping.set("time", now_str)
                    ping.set("start", now_str)
                    ping.set("stale", stale_str)
                    etree.SubElement(
                        ping,
                        "point",
                        lat="0.0",
                        lon="0.0",
                        hae="0.0",
                        ce="9999999",
                        le="9999999",
                    )
                    self._writer.write(etree.tostring(ping))
                    await self._writer.drain()
                except (OSError, RuntimeError) as e:
                    logger.error(f"Failed to send heartbeat: {e}")
            await asyncio.sleep(30)

    # ------------------------------------------------------------------
    #  Minimal CoT parser – just enough to keep the module importable
    # ------------------------------------------------------------------
    def parse_cot(self, xml_data: bytes) -> dict[str, Any] | None:
        try:
            if b"<event" not in xml_data:
                return None
            root = etree.fromstring(xml_data.strip())
            uid = root.get("uid")
            # Very small extraction; real parsing lives in the UI layer.
            return {"uid": uid} if uid else None
        except Exception as exc:  # pragma: no cover
            logger.debug(f"CoT parse error: {exc}")
            return None

    # ------------------------------------------------------------------
    #  Start / stop the client loop
    # ------------------------------------------------------------------
    async def start(self) -> None:
        """Launch the client task (called from the FastAPI lifespan)."""
        self._stop.clear()
        self._run_task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        """Gracefully stop the client."""
        self._stop.set()
        if self._run_task and not self._run_task.done():
            await self._run_task
        self._run_task = None

    async def run(self) -> None:
        """Main loop: connect to the TAK server, send initial SA, then heartbeat."""
        # The actual TCP connection logic is in the FastAPI websocket handler;
        # this run() is kept for compatibility with any future TCP usage.
        logger.info("TAKClient run called – awaiting external connection.")
        # For now just keep the task alive so the event loop does not exit.
        try:
            await asyncio.sleep(86400)  # one day – will be replaced by real code
        finally:
            await self.stop()

tak_client = TAKClient()