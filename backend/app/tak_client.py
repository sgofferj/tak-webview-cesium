import asyncio
import datetime
import json
import logging
import os
import re
import ssl
import time
from typing import Any

import msgpack  # type: ignore
from lxml import etree

from .config import Settings

logger = logging.getLogger("tak-webview.tak_client")

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
    def __init__(self, config: Settings, broadcast_callback: Any):
        self.config = config
        self.broadcast = broadcast_callback
        self.running = False
        self._task: asyncio.Task[None] | None = None
        # State tracking for throttling
        self._last_send_time: dict[str, float] = {}

    def create_heartbeat(self) -> bytes:
        now = datetime.datetime.now(datetime.UTC)
        stale = now + datetime.timedelta(seconds=60)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

        return (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<event version="2.0" uid="{self.config.tak_uid}" '
            f'type="{self.config.tak_type}" '
            f'time="{now_str}" start="{now_str}" stale="{stale_str}" how="h-g-i-g-o">'
            f'<point lat="0.0" lon="0.0" hae="0.0" ce="9999999" le="9999999"/>'
            f'<detail><contact callsign="{self.config.tak_callsign}"/></detail>'
            f"</event>"
        ).encode()

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

            # Suggestion 3: Coordinate Rounding (6 decimal places ~11cm)
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
                if not data.get("squawk") and isinstance(remarks, str) and remarks:
                    re_match = re.search(r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.I)
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

        # Suggestion 2: Throttling (Frequency Capping)
        is_emergency = (
            data.get("emergency") and data["emergency"].get("status") == "active"
        )
        if not is_emergency:
            last_send = self._last_send_time.get(uid, 0)
            if now - last_send < self.config.ws_throttle:
                return

        self._last_send_time[uid] = now

        # Suggestion 5: Key Minification
        minified = {KEY_MAP.get(k, k): v for k, v in data.items()}

        # Suggestion 4: MessagePack (Binary Serialization)
        if self.config.use_msgpack:
            payload = msgpack.packb(minified)
        else:
            payload = json.dumps(minified)

        await self.broadcast(payload)

    async def run(self) -> None:
        self.running = True
        ssl_ctx = self._setup_ssl()
        if not ssl_ctx:
            return

        while self.running:
            try:
                logger.info(
                    "Connecting to TAK Server at %s:%s...",
                    self.config.tak_host,
                    self.config.tak_port,
                )
                reader, writer = await asyncio.open_connection(
                    self.config.tak_host, self.config.tak_port, ssl=ssl_ctx
                )
                try:
                    logger.info("Connected to TAK Server.")
                    await asyncio.gather(
                        self._send_heartbeats(writer), self._process_stream(reader)
                    )
                except Exception as e:
                    logger.warning("Connection lost: %s", e)
                finally:
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
            except Exception as e:
                if self.running:
                    logger.error("TAK Connection error: %s. Retrying in 5s...", e)
                    await asyncio.sleep(5)

    def stop(self) -> None:
        self.running = False

    def _setup_ssl(self) -> ssl.SSLContext | None:
        if not (self.config.tak_tls_client_cert and self.config.tak_tls_client_key):
            logger.error("Missing TLS certificates. Cannot start TAK Client.")
            return None

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        if self.config.tak_tls_ca_cert and os.path.exists(self.config.tak_tls_ca_cert):
            ctx.load_verify_locations(cafile=self.config.tak_tls_ca_cert)
        else:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

        try:
            ctx.load_cert_chain(
                certfile=self.config.tak_tls_client_cert,
                keyfile=self.config.tak_tls_client_key,
            )
            return ctx
        except Exception as e:
            logger.error("Failed to load certificates: %s", e)
            return None

    async def _send_heartbeats(self, writer: asyncio.StreamWriter) -> None:
        while self.running:
            try:
                writer.write(self.create_heartbeat())
                await writer.drain()
                await asyncio.sleep(30)
            except Exception:
                break

    async def _process_stream(self, reader: asyncio.StreamReader) -> None:
        buffer = b""
        while self.running:
            try:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"</event>" in buffer:
                    idx = buffer.find(b"</event>") + 8
                    msg = buffer[:idx]
                    buffer = buffer[idx:]
                    parsed = self.parse_cot(msg)
                    if parsed:
                        await self._broadcast_if_needed(parsed)
            except Exception:
                break
