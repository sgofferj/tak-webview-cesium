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
    "xmpp": "x",
    "mail": "m",
    "phone": "p",
    "battery": "b",
    "how": "h",
    "group_role": "gr",
    "group_name": "gn",
    "ce": "ce",
}


class TAKClient:
    def __init__(
        self,
        config: Settings = settings,
        on_cot: Callable[[Any], Any] | Callable[[Any], Awaitable[Any]] | None = None,
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

        # Only use ephemeral certs
        cert_file = os.path.join(self.config.ephemeral_dir, self.config.ephemeral_cert)
        key_file = os.path.join(self.config.ephemeral_dir, self.config.ephemeral_key)
        ca_file = os.path.join(self.config.ephemeral_dir, self.config.ephemeral_ca)

        logger.debug(f"SSL Context: cert={cert_file}, key={key_file}, ca={ca_file}")

        if not os.path.exists(cert_file):
            logger.error(f"Certificate file missing: {cert_file}")
            raise FileNotFoundError(f"Certificate file missing: {cert_file}")
        if not os.path.exists(key_file):
            logger.error(f"Key file missing: {key_file}")
            raise FileNotFoundError(f"Key file missing: {key_file}")

        logger.info("Using ephemeral certificate")
        from .auth import auth_manager

        password = (
            auth_manager.cert_password.encode("utf-8")
            if auth_manager.cert_password
            else None
        )
        ctx.load_cert_chain(certfile=cert_file, keyfile=key_file, password=password)
        if os.path.exists(ca_file):
            logger.debug(f"Loading CA from: {ca_file}")
            ctx.load_verify_locations(cafile=ca_file)
        else:
            logger.warning(
                f"CA file not found: {ca_file}. Disabling hostname verification."
            )
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

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
                except (OSError, RuntimeError) as e:
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
            data: dict[str, Any] = {
                "uid": uid,
                "type": ctype,
                "how": root.get("how", "h-e"),
                "callsign": uid,
                "lat": round(float(point.get("lat", 0)), 6),
                "lon": round(float(point.get("lon", 0)), 6),
                "alt": round(float(point.get("hae", 0)), 1),
                "ce": round(float(point.get("ce", 9999999)), 1),
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

                    # Contact info
                    val = contact.get("xmppUsername")
                    if val: data["xmpp"] = val
                    val = contact.get("emailAddress")
                    if val: data["mail"] = val
                    val = contact.get("phone")
                    if val: data["phone"] = val

                status_el = detail.find("status")
                if status_el is not None:
                    batt = status_el.get("battery")
                    if batt is not None and batt != "":
                        try:
                            data["battery"] = int(batt)
                        except (ValueError, TypeError):
                            pass

                group_el = detail.find("__group")
                if group_el is not None:
                    data["group_role"] = group_el.get("role")
                    data["group_name"] = group_el.get("name")
                else:
                    data["group_role"] = data["group_name"] = None

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
                if not data.get("squawk") and isinstance(remarks, str) and remarks:
                    re_match = re.search(r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.I)
                    if re_match:
                        data["squawk"] = re_match.group(1)
            else:
                # Detail is missing, clear all detail fields
                data["battery"] = data["group_role"] = data["group_name"] = None
                data["xmpp"] = data["mail"] = data["phone"] = None

            return data
        except (etree.LxmlError, ValueError, TypeError) as e:
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
        self._stop = False
        from .auth import auth_manager

        # Use the enrolled server if we have one, otherwise fallback to config
        tak_host = auth_manager.enrolled_server or self.config.tak_host

        logger.info(
            f"Connecting to TAK Server at " f"{tak_host}:{self.config.tak_port}"
        )
        asyncio.create_task(self._send_heartbeat())

        while not self._stop:
            try:
                ctx = self._get_ssl_context()
                self._reader, self._writer = await asyncio.open_connection(
                    tak_host, self.config.tak_port, ssl=ctx
                )
                logger.info("Connected to TAK Server")

                while not self._stop:
                    # Read until end of event
                    data = await self._reader.readuntil(b"</event>")
                    if not data:
                        break

                    if self.config.log_cots:
                        logger.debug(f"Received CoT: {data.decode(errors='replace')}")

                    parsed = self.parse_cot(data)
                    if parsed:
                        if self.on_cot:
                            if asyncio.iscoroutinefunction(self.on_cot):
                                await self.on_cot(parsed)
                            else:
                                self.on_cot(parsed)
                        await self._broadcast_if_needed(parsed)

            except (
                OSError,
                ssl.SSLError,
                asyncio.IncompleteReadError,
                etree.LxmlError,
            ) as e:
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
            except (OSError, RuntimeError):
                pass
            self._writer = None


tak_client = TAKClient()
