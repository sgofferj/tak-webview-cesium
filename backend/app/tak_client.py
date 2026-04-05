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

import cachetools
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
    "staff_comment": "sc",
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
        self._run_task: asyncio.Task[None] | None = None
        # State tracking for throttling
        self._last_send_time: cachetools.TTLCache[str, float] = cachetools.TTLCache(
            maxsize=1000, ttl=60
        )

        # Parse staff comments:
        # "#shadowfleet=SF,#LEO=LEO" -> {"#shadowfleet": "SF", "#LEO": "LEO"}
        self.staff_comments: dict[str, str] = {}
        if self.config.tak_staff_comments:
            # Strip quotes that might be passed from shell/docker
            raw_val = self.config.tak_staff_comments.strip("\"'")
            for pair in raw_val.split(","):
                if "=" in pair:
                    pattern, comment = pair.split("=", 1)
                    # Also strip each side to be safe
                    self.staff_comments[pattern.strip("\"' ")] = comment.strip("\"' ")

    def _get_ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
        from .auth import auth_manager

        # Only use ephemeral certs
        cert_file = os.path.join(self.config.ephemeral_dir, self.config.ephemeral_cert)
        ca_file = os.path.join(self.config.ephemeral_dir, self.config.ephemeral_ca)

        if not os.path.exists(cert_file):
            raise FileNotFoundError(f"Certificate file missing: {cert_file}")

        logger.info("Initializing secure SSL context (RAM-only key)")

        # 1. Get decrypted key from AuthManager (RAM only)
        key_bytes = auth_manager.get_private_key()
        if not key_bytes:
            raise RuntimeError("Failed to decrypt private key in RAM")

        # 2. Read cert from disk
        with open(cert_file, "rb") as f:
            cert_bytes = f.read()

        # 3. Use memfd to feed bytes to ssl.load_cert_chain (Linux only)
        fd_cert = os.memfd_create("tak_cert", 0)
        fd_key = os.memfd_create("tak_key", 0)

        try:
            os.write(fd_cert, cert_bytes)
            os.write(fd_key, key_bytes)

            # Reset offsets
            os.lseek(fd_cert, 0, 0)
            os.lseek(fd_key, 0, 0)

            # Python's ssl library can load from /dev/fd/ paths
            ctx.load_cert_chain(
                certfile=f"/dev/fd/{fd_cert}", keyfile=f"/dev/fd/{fd_key}"
            )
        finally:
            os.close(fd_cert)
            os.close(fd_key)

        if os.path.exists(ca_file):
            ctx.load_verify_locations(cafile=ca_file)
        else:
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

                    # 1. SA heartbeat (a-f-G-U-C)
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

                    self._writer.write(etree.tostring(cot))

                    # 2. takPing (t-x-c-t)
                    ping = etree.Element("event")
                    ping.set("version", "2.0")
                    ping.set("uid", f"{self.config.tak_callsign}-ping")
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

    def parse_cot(self, xml_data: bytes) -> dict[str, Any] | None:
        try:
            if b"<event" not in xml_data:
                return None

            root = etree.fromstring(xml_data.strip())
            uid = root.get("uid")
            ctype = root.get("type")
            if not uid or not ctype:
                return None

            # Discard specific CoT types or those containing "ping" / "pong"
            # as these are internal server messages and not actual entities.
            if ctype == "t-x-c-t":
                return None
            
            # Check for ping/pong in uid or callsign (case-insensitive)
            # Some servers send pings with different CoT types but specific uids/callsigns
            uid_lower = uid.lower()
            if "ping" in uid_lower or "pong" in uid_lower or "takping" in uid_lower or "takpong" in uid_lower:
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
                    if val:
                        data["xmpp"] = val
                    val = contact.get("emailAddress")
                    if val:
                        data["mail"] = val
                    val = contact.get("phone")
                    if val:
                        data["phone"] = val

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

                milsym = detail.find("__milsym")
                if milsym is not None:
                    data["milsym"] = milsym.get("id")

                milicon = detail.find("__milicon")
                if milicon is not None:
                    data["milicon"] = milicon.get("id")

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

                # Match staff comments based on remarks
                remarks = data.get("remarks")
                if isinstance(remarks, str) and remarks:
                    # Squawk fallback
                    if not data.get("squawk"):
                        re_match = re.search(
                            r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.I
                        )
                        if re_match:
                            data["squawk"] = re_match.group(1)

                    # Staff comments
                    for pattern, comment in self.staff_comments.items():
                        if pattern.lower() in remarks.lower():
                            data["staff_comment"] = comment
                            break
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

    async def start(self) -> None:
        """Start the TAK client loop, ensuring only one is running."""
        if self._run_task and not self._run_task.done():
            logger.info("TAK client already running, restarting...")
            await self.stop()

        self._stop = False
        self._run_task = asyncio.create_task(self.run())

    async def run(self) -> None:
        from .auth import auth_manager

        # Use the enrolled server if we have one, otherwise fallback to config
        tak_host = auth_manager.enrolled_server or self.config.tak_host

        logger.info(
            f"Connecting to TAK Server at " f"{tak_host}:{self.config.tak_port}"
        )

        # Start heartbeat as a task we can track if needed, or just part of this loop
        heartbeat_task = asyncio.create_task(self._send_heartbeat())

        try:
            while not self._stop:
                try:
                    ctx = self._get_ssl_context()
                    self._reader, self._writer = await asyncio.open_connection(
                        tak_host, self.config.tak_port, ssl=ctx
                    )
                    logger.info("Connected to TAK Server")

                    while not self._stop:
                        # Read until end of event
                        try:
                            data = await self._reader.readuntil(b"</event>")
                        except asyncio.LimitOverrunError:
                            logger.warning("CoT event too large, skipping buffer...")
                            await self._reader.read(1024)
                            continue

                        if not data:
                            break

                        if self.config.log_cots:
                            logger.debug(
                                f"Received CoT: {data.decode(errors='replace')}"
                            )

                        parsed = await asyncio.to_thread(self.parse_cot, data)
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
                    if not self._stop:
                        logger.error(f"Connection error: {e}. Retrying in 10s...")
                        self._writer = None
                        await asyncio.sleep(10)
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass

    async def stop(self) -> None:
        self._stop = True
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except (OSError, RuntimeError, asyncio.CancelledError):
                pass
            self._writer = None

        if self._run_task and not self._run_task.done():
            self._run_task.cancel()
            try:
                await self._run_task
            except asyncio.CancelledError:
                pass
            self._run_task = None


tak_client = TAKClient()
