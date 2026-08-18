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
import uuid
from collections import deque
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

# Keepalive timers from the takproto spec:
# ping (t-x-c-t) starts RX_STALE_SECONDS after the last inbound event, repeats
# every PING_INTERVAL_SECONDS, and the connection is dropped after
# RX_DEAD_SECONDS of silence. The SA position report is refreshed at half its
# 60s stale window.
RX_STALE_SECONDS = 15.0
PING_INTERVAL_SECONDS = 4.5
RX_DEAD_SECONDS = 25.0
SA_INTERVAL_SECONDS = 30.0

# Geochat (b-t-f). Threads are keyed by chatgrp id (peer uid for DMs, room
# name for broadcasts). History is a bounded per-thread ring buffer because
# TAK Server 5.7 has no store-and-forward for chat (verified live).
CHAT_ROOM_ALL = "All Chat Rooms"
CHAT_HISTORY_PER_THREAD = 200
CHAT_HISTORY_MAX_THREADS = 50
CHAT_MAX_TEXT = 4000


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
        self._heartbeat_task: asyncio.Task[None] | None = None
        # Keepalive state (per connection, reset in run())
        self._last_inbound: float = 0.0
        self._last_ping: float = 0.0
        self._connection_dead = False
        # Serializes writes (heartbeat vs clean-stop delete) on one stream.
        self._write_lock = asyncio.Lock()

        # State tracking for throttling
        self._last_send_time: cachetools.TTLCache[str, float] = cachetools.TTLCache(
            maxsize=1000, ttl=60
        )

        # Geochat state
        self._chat_threads: dict[str, deque[dict[str, Any]]] = {}
        # Live SA contacts (uid -> info) for the DM recipient list
        self._chat_contacts: dict[str, dict[str, Any]] = {}

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

    @property
    def chat_callsign(self) -> str:
        """Callsign used for chat: the user-configured one when set."""
        return self.config.tak_callsign_input or self.config.tak_callsign

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

    def _build_sa_event(self) -> etree._Element:
        """SA position report - also serves as the initial identification.

        Verified live against TAK Server 5.7 + ATAK-CIV 5.8: the contact
        needs endpoint="*:-1:stcp" for other clients to treat us as
        geochat-capable, and __group name must be a valid team color.
        """
        now = datetime.datetime.now(datetime.UTC)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = (now + datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

        cot = etree.Element("event")
        cot.set("version", "2.0")
        cot.set("uid", self.config.tak_uid_final)
        cot.set("type", "a-f-G-U-C")
        cot.set("how", "m-g")
        cot.set("time", now_str)
        cot.set("start", now_str)
        cot.set("stale", stale_str)
        cot.set("access", "Undefined")

        point = etree.SubElement(cot, "point")
        point.set("lat", "0")
        point.set("lon", "0")
        point.set("hae", "0")
        point.set("ce", "9999999")
        point.set("le", "9999999")

        detail = etree.SubElement(cot, "detail")
        contact = etree.SubElement(detail, "contact")
        contact.set("callsign", self.chat_callsign)
        contact.set("endpoint", "*:-1:stcp")

        # Add __group for TAK server (color, not cert group)
        group = etree.SubElement(detail, "__group")
        group.set("name", self.config.tak_color or self.config.tak_group_color)
        group.set("role", self.config.tak_role or "Team Member")
        status = etree.SubElement(detail, "status")
        status.set("battery", "100")

        takv = etree.SubElement(detail, "takv")
        takv.set("device", "WebView")
        takv.set("os", "linux")
        takv.set("platform", "TAK")
        takv.set("version", "1.0")

        return cot

    def _build_ping_event(self) -> etree._Element:
        """Keepalive ping (t-x-c-t) with deviceuid-ping UID per the spec."""
        now = datetime.datetime.now(datetime.UTC)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = (now + datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

        ping = etree.Element("event")
        ping.set("version", "2.0")
        ping.set("uid", f"{self.config.tak_uid_final}-ping")
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

        return ping

    def _build_self_delete_event(self) -> etree._Element:
        """Display delete task (t-x-d-d) announcing our own removal."""
        now = datetime.datetime.now(datetime.UTC)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = (now + datetime.timedelta(seconds=20)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

        event = etree.Element("event")
        event.set("version", "2.0")
        event.set("uid", str(uuid.uuid4()))
        event.set("type", "t-x-d-d")
        event.set("how", "h-g-i-g-o")
        event.set("time", now_str)
        event.set("start", now_str)
        event.set("stale", stale_str)
        # Dummy point, mirroring the canonical delete-task format
        etree.SubElement(
            event,
            "point",
            lat="0",
            lon="0",
            hae="0",
            ce="9999999",
            le="9999999",
        )
        detail = etree.SubElement(event, "detail")
        link = etree.SubElement(detail, "link")
        link.set("relation", "p-p")
        link.set("uid", self.config.tak_uid_final)
        link.set("type", "a-f-G-U-C")
        return event

    async def _send_xml(self, root: etree._Element) -> None:
        async with self._write_lock:
            if self._writer is None:
                return
            try:
                self._writer.write(etree.tostring(root))
                await self._writer.drain()
            except (OSError, RuntimeError) as e:
                logger.error("Failed to send CoT: %s", e)

    async def _heartbeat_loop(self) -> None:
        """Keep the SA fresh and drive the spec ping/pong timers.

        The SA report is sent immediately on connect (identification), then
        refreshed every SA_INTERVAL_SECONDS. Pings only start once inbound
        traffic went stale (RX_STALE_SECONDS), repeat at PING_INTERVAL_SECONDS
        and the connection is declared dead after RX_DEAD_SECONDS of silence;
        the read loop then reconnects.
        """
        last_sa = 0.0
        while not self._stop:
            now = time.monotonic()
            silence = now - self._last_inbound

            if silence >= RX_DEAD_SECONDS:
                logger.warning(
                    "No inbound traffic for %.0fs, declaring connection dead",
                    silence,
                )
                self._connection_dead = True
                return

            if now - last_sa >= SA_INTERVAL_SECONDS:
                last_sa = now
                await self._send_xml(self._build_sa_event())

            if (
                silence >= RX_STALE_SECONDS
                and now - self._last_ping >= PING_INTERVAL_SECONDS
            ):
                self._last_ping = now
                await self._send_xml(self._build_ping_event())

            await asyncio.sleep(1.0)

    def parse_cot(self, xml_data: bytes) -> dict[str, Any] | None:
        try:
            if b"<event" not in xml_data:
                return None

            root = etree.fromstring(xml_data.strip())
            uid = root.get("uid")
            ctype = root.get("type")
            if not uid or not ctype:
                return None

            # Discard every CoT type that doesn't start with "a-" (Atoms).
            # This project focuses on 3D visualization of tactical entities (atoms).
            # Internal server messages, pings, chat, drawings (lines/polygons), etc.,
            # which use different prefixes (e.g., "t-", "b-", "u-"), are discarded here.
            # NOTE: If future features like chat or shared drawings are added,
            # this filter will need to be updated to allow those specific types.
            if not ctype.startswith("a-") and b"<emergency" not in xml_data:
                return None

            # Check for ping/pong in uid or callsign (case-insensitive)
            # Some servers send pings with different CoT types but specific
            # uids/callsigns
            uid_lower = uid.lower()
            if any(p in uid_lower for p in ["ping", "pong", "takping", "takpong"]):
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
                    # Extract endpoint for geochat capability detection
                    endpoint = contact.get("endpoint")
                    if endpoint:
                        data["endpoint"] = endpoint
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

    # ------------------------------------------------------------------
    # Geochat (b-t-f)
    # ------------------------------------------------------------------

    def parse_chat(self, xml_data: bytes) -> dict[str, Any] | None:
        """Parse an inbound b-t-f chat event (ATAK 5.8 wire format).

        Returns a normalized chat dict, or None if the event is not a chat
        message (e.g. b-t-f-d/b-t-f-r receipts, malformed XML, empty text).
        Thread key is the chatgrp id: the peer uid for DMs, the room name for
        broadcasts.
        """
        try:
            root = etree.fromstring(xml_data.strip())
        except etree.LxmlError:
            return None
        uid = root.get("uid")
        ctype = root.get("type")
        if not uid or ctype != "b-t-f":
            return None
        detail = root.find("detail")
        if detail is None:
            return None
        chat_el = detail.find("__chat")
        if chat_el is None:
            return None
        remarks_el = detail.find("remarks")
        text = (remarks_el.text or "").strip() if remarks_el is not None else ""
        if not text:
            return None

        room = chat_el.get("chatroom") or chat_el.get("id") or ""
        grp_id = chat_el.get("id") or room
        parent = chat_el.get("parent", "")
        grp = chat_el.find("chatgrp")
        uid0 = grp.get("uid0") if grp is not None else None
        uid1 = grp.get("uid1") if grp is not None else None
        my_uid = self.config.tak_uid_final

        # DM vs room: room messages carry the room as chatgrp id and/or use
        # parent TeamGroups. DMs carry the two participant uids.
        kind = "dm"
        others = [u for u in (uid0, uid1) if u and u != my_uid and u != grp_id]
        if parent == "TeamGroups" or (grp_id and grp_id == room and grp_id != my_uid):
            kind = "room"
            thread = grp_id or room
        else:
            thread = others[0] if others else (grp_id or room)
            if grp_id and grp_id == my_uid and not others:
                # DM addressed to us, but neither participant is another uid
                thread = uid0 or uid1 or my_uid

        link = detail.find("link")
        sender_uid = link.get("uid") if link is not None else None
        sender = chat_el.get("senderCallsign") or ""
        if not sender:
            source = remarks_el.get("source") if remarks_el is not None else ""
            if source:
                source_uid = source.rsplit(".", 1)[-1]
                contact = self._chat_contacts.get(source_uid)
                sender = (
                    str(contact.get("callsign") or source_uid)
                    if contact
                    else source_uid
                )
        if not sender:
            sender = sender_uid or uid

        return {
            "uid": uid,
            "type": ctype,
            "how": root.get("how", "h-g-i-g-o"),
            "time": root.get("time"),
            "start": root.get("start"),
            "stale": root.get("stale"),
            "thread": thread,
            "room": room,
            "kind": kind,
            "message_id": chat_el.get("messageId") or uid,
            "sender": sender,
            "sender_uid": sender_uid or uid,
            "peer": thread if kind == "dm" else None,
            "text": text,
            "self": False,
        }

    def _build_chat_event(
        self,
        room: str,
        peer_uid: str | None,
        peer_callsign: str | None,
        text: str,
        message_id: str,
    ) -> etree._Element:
        """Build an outbound chat event in the ATAK 5.8 wire format.

        Format verified live against TAK Server 5.7 + ATAK-CIV 5.8: the
        __chat needs parent/groupOwner/messageId/chatroom/id/senderCallsign,
        a uid0/uid1 chatgrp, a p-p link to the sender, and remarks@source.
        Classic-format chat relays but ATAK 5.8 does not display it.
        """
        my_uid = self.config.tak_uid_final
        is_dm = bool(peer_uid)
        target = peer_uid or room or CHAT_ROOM_ALL
        grp_id = target
        if not is_dm:
            parent = "RootContactGroup" if target == CHAT_ROOM_ALL else "TeamGroups"
            uid1 = CHAT_ROOM_ALL if target == CHAT_ROOM_ALL else my_uid
        else:
            parent = "RootContactGroup"
            uid1 = target
        chatroom = peer_callsign or target

        now = datetime.datetime.now(datetime.UTC)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = (now + datetime.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")

        event = etree.Element("event")
        event.set("version", "2.0")
        event.set("uid", f"GeoChat.{my_uid}.{target}.{uuid.uuid4()}")
        event.set("type", "b-t-f")
        event.set("how", "h-g-i-g-o")
        event.set("time", now_str)
        event.set("start", now_str)
        event.set("stale", stale_str)
        event.set("access", "Undefined")

        point = etree.SubElement(event, "point")
        point.set("lat", "0")
        point.set("lon", "0")
        point.set("hae", "0")
        point.set("ce", "9999999")
        point.set("le", "9999999")

        detail = etree.SubElement(event, "detail")
        chat_el = etree.SubElement(detail, "__chat")
        chat_el.set("parent", parent)
        chat_el.set("groupOwner", "false")
        chat_el.set("messageId", message_id)
        chat_el.set("chatroom", chatroom)
        chat_el.set("id", grp_id)
        chat_el.set("senderCallsign", self.chat_callsign)
        grp_el = etree.SubElement(chat_el, "chatgrp")
        grp_el.set("uid0", my_uid)
        grp_el.set("uid1", uid1)
        grp_el.set("id", grp_id)

        link = etree.SubElement(detail, "link")
        link.set("uid", my_uid)
        link.set("type", "a-f-G-U-C")
        link.set("relation", "p-p")

        remarks = etree.SubElement(detail, "remarks")
        remarks.set("source", f"BAO.F.ATAK.{my_uid}")
        remarks.text = text

        return event

    async def send_chat(
        self,
        room: str,
        peer_uid: str | None,
        peer_callsign: str | None,
        text: str,
        client_id: str,
    ) -> dict[str, Any]:
        """Send a chat message and mirror it to the web clients.

        client_id is generated by the frontend and echoed back as messageId,
        letting tabs deduplicate their optimistic send against the real one.
        """
        text = (text or "").strip()
        if not text:
            raise ValueError("Empty chat message")
        if len(text) > CHAT_MAX_TEXT:
            raise ValueError(f"Chat message exceeds {CHAT_MAX_TEXT} characters")

        message_id = client_id or str(uuid.uuid4())
        root = self._build_chat_event(room, peer_uid, peer_callsign, text, message_id)
        await self._send_xml(root)

        now = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        chat = {
            "uid": root.get("uid"),
            "type": "b-t-f",
            "how": "h-g-i-g-o",
            "time": now,
            "start": now,
            "stale": root.get("stale"),
            "thread": peer_uid or room or CHAT_ROOM_ALL,
            "room": room or CHAT_ROOM_ALL,
            "kind": "dm" if peer_uid else "room",
            "message_id": message_id,
            "sender": self.chat_callsign,
            "sender_uid": self.config.tak_uid_final,
            "peer": peer_uid,
            "text": text,
            "self": True,
        }
        await self._push_chat(chat)
        return chat

    async def _push_chat(self, chat: dict[str, Any]) -> None:
        """Append to the per-thread ring buffer and push to web clients."""
        thread = chat["thread"]
        if thread not in self._chat_threads:
            if len(self._chat_threads) >= CHAT_HISTORY_MAX_THREADS:
                # Drop the least-recently-written thread to bound memory
                oldest = min(
                    self._chat_threads,
                    key=lambda k: self._chat_threads[k][-1].get("time") or "",
                )
                del self._chat_threads[oldest]
            self._chat_threads[thread] = deque(maxlen=CHAT_HISTORY_PER_THREAD)
        self._chat_threads[thread].append(chat)
        await self._broadcast_chat(chat)

    async def _broadcast_chat(self, chat: dict[str, Any]) -> None:
        payload: dict[str, Any] = {"chat": chat}
        if self.config.use_msgpack:
            await manager.broadcast(msgpack.packb(payload))
        else:
            await manager.broadcast(json.dumps(payload))

    def chat_snapshot(self) -> dict[str, Any]:
        """Full chat state for a freshly connected web client."""
        return {
            "self": {
                "uid": self.config.tak_uid_final,
                "callsign": self.chat_callsign,
            },
            "threads": {k: list(v) for k, v in self._chat_threads.items()},
            "contacts": dict(self._chat_contacts),
        }

    # ------------------------------------------------------------------
    # Chat contact registry (live SA users, for the DM recipient list)
    # ------------------------------------------------------------------
    def _update_contact(
        self, parsed: dict[str, Any]
    ) -> tuple[str, dict[str, Any]] | None:
        """Track a live SA contact; returns (uid, info) when new/changed."""
        uid = parsed["uid"]
        if uid == self.config.tak_uid_final:
            return None
        info = {
            "callsign": parsed.get("callsign") or uid,
            "group_name": parsed.get("group_name"),
            "group_role": parsed.get("group_role"),
            "stale": parsed.get("stale"),
        }
        known = self._chat_contacts.get(uid)
        self._chat_contacts[uid] = info
        if known is None or known.get("callsign") != info["callsign"]:
            return (uid, info)
        return None

    def _parse_delete(self, xml_data: bytes) -> list[str]:
        """Parse a t-x-d-d delete task and return the UIDs it targets.

        Mirrors ATAK's CotDeleteImporter: acts only when detail/link carries
        all three attributes (uid, relation, type) non-empty. Link-less
        t-x-d-d events are keepalives repurposing the codepoint, not deletes,
        and are ignored. Our own UID is skipped so a remote delete cannot
        remove our own SA entity.
        """
        removed: list[str] = []
        try:
            root = etree.fromstring(xml_data.strip())
        except etree.LxmlError:
            return removed
        if root.get("type") != "t-x-d-d":
            return removed
        link = root.find("detail/link")
        if link is None:
            return removed
        uid = link.get("uid")
        relation = link.get("relation")
        type_ = link.get("type")
        if not uid or not relation or not type_:
            return removed
        if uid == self.config.tak_uid_final:
            return removed
        self._chat_contacts.pop(uid, None)
        removed.append(uid)
        return removed

    async def _apply_delete(self, xml_data: bytes) -> None:
        """Handle an inbound t-x-d-d: prune the contact and tell the web
        clients so the map entity is removed too."""
        removed = await asyncio.to_thread(self._parse_delete, xml_data)
        if removed:
            await self._broadcast_cot_delete(removed)

    async def _broadcast_cot_delete(self, uids: list[str]) -> None:
        payload: dict[str, Any] = {"cot_delete": uids}
        if self.config.use_msgpack:
            await manager.broadcast(msgpack.packb(payload))
        else:
            await manager.broadcast(json.dumps(payload))

    async def _broadcast_contacts_update(self, uid: str, info: dict[str, Any]) -> None:
        payload: dict[str, Any] = {"contacts_update": {uid: info}}
        if self.config.use_msgpack:
            await manager.broadcast(msgpack.packb(payload))
        else:
            await manager.broadcast(json.dumps(payload))

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

    @property
    def is_running(self) -> bool:
        return self._run_task is not None and not self._run_task.done()

    async def start(self) -> None:
        """Start the TAK client loop, ensuring only one is running."""
        if self.is_running:
            logger.info("TAK client already running, not restarting")
            return

        self._stop = False
        self._run_task = asyncio.create_task(self.run())

    async def run(self) -> None:
        from .auth import auth_manager

        # Use the enrolled server if we have one, otherwise fallback to config
        tak_host = auth_manager.enrolled_server or self.config.tak_host

        logger.info(
            f"Connecting to TAK Server at " f"{tak_host}:{self.config.tak_port}"
        )

        while not self._stop:
            try:
                ctx = self._get_ssl_context()
                self._reader, self._writer = await asyncio.open_connection(
                    tak_host, self.config.tak_port, ssl=ctx
                )
                logger.info("Connected to TAK Server")

                # Per-connection keepalive state
                self._last_inbound = time.monotonic()
                self._last_ping = 0.0
                self._connection_dead = False
                self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

                try:
                    while not self._stop:
                        # Read until end of event; 1s tick so the heartbeat's
                        # dead-connection detection can abort a silent stream.
                        try:
                            data = await asyncio.wait_for(
                                self._reader.readuntil(b"</event>"), timeout=1.0
                            )
                        except TimeoutError:
                            if self._connection_dead:
                                logger.info("Connection declared dead, reconnecting")
                                break
                            continue
                        except asyncio.LimitOverrunError:
                            logger.warning("CoT event too large, skipping buffer...")
                            await self._reader.read(1024)
                            continue

                        if not data:
                            break

                        self._last_inbound = time.monotonic()

                        if self.config.log_cots:
                            logger.debug(
                                f"Received CoT: {data.decode(errors='replace')}"
                            )

                        # Geochat: b-t-f events bypass the atom pipeline.
                        if b"b-t-f" in data:
                            chat = await asyncio.to_thread(self.parse_chat, data)
                            if chat:
                                # Update contact from chat sender info
                                sender_uid = chat.get("sender_uid")
                                sender = chat.get("sender")
                                if (
                                    sender_uid
                                    and sender
                                    and sender_uid != self.config.tak_uid_final
                                ):
                                    info = self._chat_contacts.get(sender_uid)
                                    new_callsign = sender
                                    if not info or info.get("callsign") != new_callsign:
                                        self._chat_contacts[sender_uid] = {
                                            "callsign": new_callsign,
                                            "group_name": (
                                                info.get("group_name") if info else None
                                            ),
                                            "group_role": (
                                                info.get("group_role") if info else None
                                            ),
                                            "stale": (
                                                info.get("stale") if info else None
                                            ),
                                        }
                                        asyncio.create_task(
                                            self._broadcast_contacts_update(
                                                sender_uid,
                                                self._chat_contacts[sender_uid],
                                            )
                                        )
                                await self._push_chat(chat)
                                continue
                        elif b"t-x-d-d" in data:
                            await self._apply_delete(data)

                        parsed = await asyncio.to_thread(self.parse_cot, data)
                        if parsed:
                            # Update chat contacts for atoms with callsign AND
                            # endpoint (geochat capable)
                            callsign = parsed.get("callsign")
                            endpoint = parsed.get("endpoint")
                            if callsign and endpoint and callsign != parsed.get("uid"):
                                changed = await asyncio.to_thread(
                                    self._update_contact, parsed
                                )
                                if changed:
                                    asyncio.create_task(
                                        self._broadcast_contacts_update(*changed)
                                    )
                            if self.on_cot:
                                if asyncio.iscoroutinefunction(self.on_cot):
                                    await self.on_cot(parsed)
                                else:
                                    self.on_cot(parsed)
                except (
                    ssl.SSLError,
                    asyncio.IncompleteReadError,
                    etree.LxmlError,
                ) as e:
                    if not self._stop:
                        logger.error(f"Connection error: {e}. Retrying in 10s...")
                        self._writer = None
                        await asyncio.sleep(10)
                finally:
                    self._cancel_heartbeat()
            except (
                ssl.SSLError,
                asyncio.IncompleteReadError,
                OSError,
            ) as e:
                if not self._stop:
                    logger.error(f"Connection failed: {e}. Retrying in 10s...")
                    await asyncio.sleep(10)

    def _cancel_heartbeat(self) -> None:
        """Cancel the per-connection heartbeat task if one is running."""
        if self._heartbeat_task is not None:
            if not self._heartbeat_task.done():
                self._heartbeat_task.cancel()
            self._heartbeat_task = None

    async def stop(self) -> None:
        """Cleanly shut down: announce our removal, then close the stream."""
        self._stop = True
        self._cancel_heartbeat()
        if self._writer is not None:
            # Soft t-x-d-d so TAK clients/server expire our SA point.
            await self._send_xml(self._build_self_delete_event())
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

    async def update_config(
        self,
        callsign: str | None = None,
        color: str | None = None,
        role: str | None = None,
    ) -> None:
        """Update callsign/color/role and restart the connection if running."""
        if callsign is not None:
            self.config.tak_callsign_input = callsign
        if color is not None:
            self.config.tak_color = color
        if role is not None:
            self.config.tak_role = role
        # Restart so the new identity is announced to the server
        await self.stop()
        await self.start()


tak_client = TAKClient()
