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
import os
import ssl
from typing import Any, Optional
from lxml import etree  # type: ignore[import-untyped]

from .auth import auth_manager
from .config import settings
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
class TAKClient:
    def __init__(self) -> None:
        self._stop = asyncio.Event()
        self._run_task: Optional[asyncio.Task[None]] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._reconnect_requested = False

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
                    logger.error("Failed to send heartbeat: %s", e)
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
            logger.debug("CoT parse error: %s", exc)
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

    def update_config(
        self,
        callsign: str | None = None,
        color: str | None = None,
        role: str | None = None,
    ) -> None:
        """Update callsign/color/role and trigger reconnect if running."""
        if callsign is not None:
            self._callsign = callsign
        if color is not None:
            self._color = color
        if role is not None:
            self._role = role
        # Trigger reconnect by setting stop event and reconnect flag
        if self._run_task and not self._run_task.done():
            self._reconnect_requested = True
        self._stop.set()

    async def run(self) -> None:
        """Main loop: connect to the TAK server, send initial SA, then heartbeat."""
        logger.info(
            "TAKClient run started – connecting to %s:%s",
            settings.tak_host,
            settings.tak_port,
        )

        # Start heartbeat task
        heartbeat_task = asyncio.create_task(self._send_heartbeat())

        # Exponential backoff for reconnection
        reconnect_delay = 5
        max_reconnect_delay = 300  # 5 minutes

        while True:
            self._stop.clear()
            try:
                await self._connect_and_read()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("TAK connection error: %s", e)
                if self._reconnect_requested:
                    # Config update requested, clear flag and reconnect immediately
                    self._reconnect_requested = False
                    reconnect_delay = 5  # Reset delay on config update
                    continue
                logger.info("Reconnecting in %d seconds...", reconnect_delay)
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_reconnect_delay)
                continue

        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        logger.info("TAKClient run stopped")

    async def _connect_and_read(self) -> None:
        """Connect to TAK server and read CoT messages."""
        # Update callsign/color/role from settings (may have been updated via API)
        self._callsign = settings.tak_callsign_input or settings.tak_callsign
        self._color = settings.tak_color
        self._role = settings.tak_role

        # Validate required config
        if not self._color:
            raise RuntimeError("TAK color not configured")
        if not self._role:
            raise RuntimeError("TAK role not configured")

        # Use enrolled server if available, fall back to config
        enrolled_server = auth_manager.enrolled_server
        if enrolled_server:
            host = enrolled_server
            logger.info("Using enrolled TAK server: %s", host)
        else:
            host = settings.tak_host
            logger.warning(
                "No enrolled server found, falling back to config: %s:%s",
                settings.tak_host,
                settings.tak_port,
            )

        # Create SSL context with client certs (RAM-only key)
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

        cert_file = auth_manager.cert_file
        ca_file = auth_manager.ca_file

        if os.path.exists(cert_file) and os.path.exists(ca_file):
            # Get decrypted private key from AuthManager (RAM only)
            key_bytes = auth_manager.get_private_key()
            if not key_bytes:
                logger.error("Failed to decrypt private key in RAM")
                raise RuntimeError("Private key not available in RAM")

            # Use memfd to feed bytes to ssl.load_cert_chain (Linux only)
            with open(cert_file, "rb") as f:
                cert_bytes = f.read()

            fd_cert = os.memfd_create("tak_cert", 0)
            fd_key = os.memfd_create("tak_key", 0)
            try:
                os.write(fd_cert, cert_bytes)
                os.write(fd_key, key_bytes)
                os.lseek(fd_cert, 0, 0)
                os.lseek(fd_key, 0, 0)
                ssl_context.load_cert_chain(
                    certfile=f"/dev/fd/{fd_cert}", keyfile=f"/dev/fd/{fd_key}"
                )
            finally:
                os.close(fd_cert)
                os.close(fd_key)

            ssl_context.load_verify_locations(cafile=ca_file)
            ssl_context.verify_mode = ssl.CERT_REQUIRED
            ssl_context.check_hostname = True
            logger.info("Initialized secure SSL context (RAM-only key)")
        else:
            logger.warning("Certificate or CA file missing, using insecure TLS")
        reader, writer = await asyncio.open_connection(
            host, settings.tak_port, ssl=ssl_context
        )
        self._reader = reader
        self._writer = writer
        logger.info("Connected to TAK server at %s:%s (TLS)", host, settings.tak_port)

        # Send initial SA
        await self._send_initial_sa()

        # Read loop - CoT is typically length-prefixed XML
        buffer = bytearray()
        while not self._stop.is_set():
            try:
                # Read data
                assert self._reader is not None
                data = await self._reader.read(4096)
                if not data:
                    logger.warning("TAK server closed connection")
                    break

                buffer.extend(data)

                # Process complete CoT messages (simple approach: split on </event>)
                while b"</event>" in buffer:
                    end_idx = buffer.index(b"</event>") + len(b"</event>")
                    message = bytes(buffer[:end_idx])
                    del buffer[:end_idx]

                    # Broadcast to frontend websocket clients
                    await manager.broadcast(message)

                    # Also parse for logging
                    parsed = self.parse_cot(message)
                    if parsed:
                        logger.debug("Received CoT: uid=%s", parsed.get("uid"))

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("Error reading from TAK server: %s", e)
                break
            finally:
                if self._writer:
                    self._writer.close()
                    await self._writer.wait_closed()
                self._reader = None
                self._writer = None


tak_client = TAKClient()
