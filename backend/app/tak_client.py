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
import json
import logging
import os
import re
import ssl
import time
from collections.abc import Awaitable, Callable
from typing import Any

import msgpack  # type: ignore
from lxml import etree

from .config import Settings, settings
from .connection import manager

logger = logging.getLogger("tak-webview.tak")


# Key mapping for minification
KEY_MAP = {
    "uid": "i",
    "type": "t",
    "callsign": "c",
    "lat": "la",
    "lon": "lo",
    "alt": "al",
    "stale": "s",
    "remarks": "r",
    "squawk": "sq",
    "course": "co",
    "speed": "sp",
    "link_url": "l",
    "color": "cl",
    "iconsetpath": "ip",
    "emergency": "e",
}


class TAKClient:
    def __init__(
        self,
        config: Settings = settings,
        on_cot: (
            Callable[[Any], Any] | Callable[[Any], Awaitable[Any]] | None
        ) = None,
    ) -> None:
        self.config = config
        self.on_cot = on_cot
        self._stop = False
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        # State tracking for throttling
        self._last_send_time: dict[str, float] = {}

    def _get_ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
        if self.config.tak_tls_ca_cert and os.path.exists(
            self.config.tak_tls_ca_cert
        ):
            ctx.load_verify_locations(cafile=self.config.tak_tls_ca_cert)
        else:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

        ctx.load_cert_chain(
            certfile=self.config.tak_tls_client_cert,
            keyfile=self.config.tak_tls_client_key,
        )
        return ctx

    async def _send_heartbeat(self) -> None:
        while not self._stop:
            if self._writer:
                try:
                    now = datetime.datetime.now(datetime.UTC)
                    stale = now + datetime.timedelta(minutes=1)
                    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                    stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

                    cot = etree.Element("event")
                    cot.set("version", "2.0")
                    cot.set("uid", self.config.tak_uid_final)
                    cot.set("type", "a-f-G-U-C")
                    cot.set("how", "m-g")
                    cot.set("time", now_str)
                    cot.set("start", now_str)
                    cot.set("stale", stale_str)

                    detail = etree.SubElement(cot, "detail")
                    contact = etree.SubElement(detail, "contact")
                    contact.set("callsign", self.config.tak_callsign)

                    # Add __group for TAK server
                    group = etree.SubElement(detail, "__group")
                    group.set("name", "Cyan")
                    group.set("role", "Team Member")

                    xml_str = etree.tostring(cot)
                    self._writer.write(xml_str)
                    await self._writer.drain()
                except Exception as e:
                    logger.error(f"Failed to send heartbeat: {e}")
            await asyncio.sleep(60)

    def parse_cot(self, xml_data: bytes) -> dict[str, Any] | None:
        try:
            if b"<event" not in xml_data:
                return None

            root = etree.fromstring(xml_data.strip())
            uid = root.get("uid")
            ctype = root.get("type")
            if not uid or not ctype:
                return None

            point = root.find("point")
            if point is None:
                return None

            # Coordinate Rounding (6 decimal places ~11cm)
            data = {
                "uid": uid,
                "type": ctype,
                "callsign": uid,
                "lat": round(float(point.get("lat", 0)), 6),
                "lon": round(float(point.get("lon", 0)), 6),
                "alt": round(float(point.get("hae", 0)), 1),
                "stale": root.get("stale"),
            }

            detail = root.find("detail")
            if detail is not None:
                contact = detail.find("contact")
                if contact is not None:
                    data["callsign"] = contact.get("callsign", uid)
                    track_val = contact.get("track")
                    if track_val:
                        data["squawk"] = track_val

                track = detail.find("track")
                if track is not None:
                    try:
                        data["course"] = round(float(track.get("course", 0)), 1)
                        data["speed"] = round(float(track.get("speed", 0)), 1)
                    except (ValueError, TypeError):
                        pass

                remarks_el = detail.find("remarks")
                if remarks_el is not None:
                    data["remarks"] = remarks_el.text or ""

                link = detail.find("link")
                if link is not None:
                    data["link_url"] = link.get("url")

                color_el = detail.find("color")
                if color_el is not None:
                    data["color"] = color_el.get("argb")

                usericon = detail.find("usericon")
                if usericon is not None:
                    data["iconsetpath"] = usericon.get("iconsetpath")

                emergency = detail.find("emergency")
                if emergency is not None:
                    if emergency.get("cancel") == "true":
                        data["emergency"] = {"status": "cancelled"}
                    else:
                        data["emergency"] = {
                            "status": "active",
                            "type": emergency.get("type", "Emergency"),
                            "value": emergency.text or "",
                        }
                        if emergency.text:
                            data["callsign"] = emergency.text

                # Squawk fallback
                remarks = data.get("remarks")
                if (
                    not data.get("squawk")
                    and isinstance(remarks, str)
                    and remarks
                ):
                    re_match = re.search(
                        r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.I
                    )
                    if re_match:
                        data["squawk"] = re_match.group(1)

            return data
        except Exception as e:
            if self.config.log_cots:
                logger.debug("CoT Parse Error: %s", e)
            return None

    async def _broadcast_if_needed(self, data: dict[str, Any]) -> None:
        uid = data["uid"]
        now = time.time()

        # Throttling (Frequency Capping)
        is_emergency = (
            data.get("emergency") and data["emergency"].get("status") == "active"
        )
        if not is_emergency:
            last_send = self._last_send_time.get(uid, 0)
            if now - last_send < self.config.ws_throttle:
                return

        self._last_send_time[uid] = now

        # Key Minification
        minified = {KEY_MAP.get(k, k): v for k, v in data.items()}

        # MessagePack (Binary Serialization)
        if self.config.use_msgpack:
            payload = msgpack.packb(minified)
        else:
            payload = json.dumps(minified)

        await manager.broadcast(payload)

    async def run(self) -> None:
        logger.info(
            f"Connecting to TAK Server at "
            f"{self.config.tak_host}:{self.config.tak_port}"
        )
        asyncio.create_task(self._send_heartbeat())

        while not self._stop:
            try:
                ctx = self._get_ssl_context()
                self._reader, self._writer = await asyncio.open_connection(
                    self.config.tak_host, self.config.tak_port, ssl=ctx
                )
                logger.info("Connected to TAK Server")

                while not self._stop:
                    # Read until end of event
                    data = await self._reader.readuntil(b"</event>")
                    if not data:
                        break

                    if self.config.log_cots:
                        logger.debug(
                            f"Received CoT: {data.decode(errors='replace')}"
                        )

                    parsed = self.parse_cot(data)
                    if parsed:
                        if self.on_cot:
                            if asyncio.iscoroutinefunction(self.on_cot):
                                await self.on_cot(parsed)
                            else:
                                self.on_cot(parsed)
                        await self._broadcast_if_needed(parsed)

            except Exception as e:
                logger.error(f"Connection error: {e}. Retrying in 10s...")
                self._writer = None
                if not self._stop:
                    await asyncio.sleep(10)

    async def stop(self) -> None:
        self._stop = True
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None


tak_client = TAKClient()
