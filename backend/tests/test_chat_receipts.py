"""Chat delivery/read receipt (b-t-f-d / b-t-f-r) tests.

Covers parsing inbound receipts, mirroring the original __chat for the
receipt event we build, the automatic b-t-f-d on receive, and the b-t-f-r
triggered by send_chat_read().
"""

import asyncio
from collections.abc import Iterator

import pytest

from app.connection import manager
from app.tak_client import Identity, TAKClient

# pylint: disable=redefined-outer-name


def _receipt_xml(receipt_type: str, message_id: str, from_uid: str) -> bytes:
    return (
        f'<event version="2.0" uid="{message_id}" type="{receipt_type}" how="m-g" '
        f'time="2026-08-19T07:00:00Z" start="2026-08-19T07:00:00Z" '
        f'stale="2026-08-20T07:00:00Z" access="Undefined"><point lat="0" lon="0" '
        f'hae="0" ce="9999999" le="9999999"/><detail><__chatreceipt '
        f'parent="RootContactGroup" groupOwner="false" messageId="{message_id}" '
        f'chatroom="ALPHA" id="UIDA" senderCallsign="BRAVO">'
        f'<chatgrp uid0="{from_uid}" uid1="UIDA" id="UIDA"/></__chatreceipt>'
        f'<link uid="{from_uid}" type="a-f-G-U-C" relation="p-p"/></detail></event>'
    ).encode()


def _chat_xml(
    message_id: str, sender_uid: str, sender_callsign: str = "BRAVO"
) -> bytes:
    return (
        f'<event version="2.0" uid="GeoChat.{sender_uid}.UIDA.{message_id}" '
        f'type="b-t-f" how="h-g-i-g-o" '
        f'time="2026-08-19T07:00:00Z" start="2026-08-19T07:00:00Z" '
        f'stale="2026-08-19T07:05:00Z" access="Undefined"><point lat="0" lon="0" '
        f'hae="0" ce="9999999" le="9999999"/><detail><__chat parent="RootContactGroup" '
        f'groupOwner="false" messageId="{message_id}" chatroom="ALPHA" id="UIDA" '
        f'senderCallsign="{sender_callsign}">'
        f'<chatgrp uid0="{sender_uid}" uid1="UIDA" id="UIDA"/></__chat>'
        f'<link uid="{sender_uid}" type="a-f-G-U-C" relation="p-p"/>'
        f'<remarks source="BAO.F.ATAK.{sender_uid}">hi</remarks></detail></event>'
    ).encode()


def _client(username: str, uid: str, callsign: str) -> TAKClient:
    return TAKClient(
        identity=Identity(
            username=username,
            uid=uid,
            callsign=callsign,
            color="",
            role="Team Member",
            server="127.0.0.1",
        )
    )


def test_parse_receipt() -> None:
    client = _client("alice", "UIDA", "ALPHA")

    delivered = client.parse_receipt(_receipt_xml("b-t-f-d", "MID-1", "UIDB"))
    assert delivered == {
        "message_id": "MID-1",
        "status": "delivered",
        "sender_uid": "UIDB",
    }

    read = client.parse_receipt(_receipt_xml("b-t-f-r", "MID-1", "UIDB"))
    assert read is not None
    assert read["status"] == "read"

    # Our own receipt echoed back by the server is ignored.
    echo = _receipt_xml("b-t-f-d", "MID-2", "UIDA")
    assert client.parse_receipt(echo) is None

    # Plain chats and other CoT types are not receipts.
    assert client.parse_receipt(_chat_xml("MID-3", "UIDB")) is None


def test_build_receipt_event() -> None:
    client = _client("alice", "UIDA", "ALPHA")
    mirror = client._extract_receipt_mirror(_chat_xml("MID-9", "UIDB"))  # noqa: SLF001
    assert mirror is not None
    assert mirror["messageId"] == "MID-9"
    assert mirror["senderUid"] == "UIDB"

    from lxml import etree

    event = client._build_receipt_event(mirror, "b-t-f-d")  # noqa: SLF001
    xml = etree.tostring(event)
    assert b'type="b-t-f-d"' in xml
    assert b'uid="MID-9"' in xml
    assert b'how="m-g"' in xml
    assert b"__chatreceipt" in xml
    assert b'messageId="MID-9"' in xml
    assert b'senderCallsign="ALPHA"' in xml
    assert b'uid0="UIDB"' in xml and b'uid1="UIDA"' in xml
    assert b'<link uid="UIDA"' in xml


class MockTakServer:
    """Relays any event from one connection to all other connections."""

    def __init__(self) -> None:
        self.connections: dict[str, asyncio.StreamWriter] = {}

    async def handle(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        name = f"conn{len(self.connections)}"
        self.connections[name] = writer
        try:
            while True:
                try:
                    data = await asyncio.wait_for(
                        reader.readuntil(b"</event>"), timeout=30
                    )
                except (asyncio.IncompleteReadError, TimeoutError):
                    break
                for other, w in list(self.connections.items()):
                    if other != name:
                        try:
                            w.write(data)
                            await w.drain()
                        except (ConnectionResetError, BrokenPipeError, OSError):
                            pass
        finally:
            try:
                writer.close()
            except OSError:
                pass


class FakeWebSocket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.sent: list[str | bytes] = []
        self.client = None

    async def accept(self) -> None:
        pass

    async def send_text(self, message: str) -> None:
        self.sent.append(message)

    async def send_bytes(self, message: bytes) -> None:
        self.sent.append(message)


def _texts(ws: FakeWebSocket) -> list[str]:
    return [m if isinstance(m, str) else m.decode(errors="replace") for m in ws.sent]


def _contains(ws: FakeWebSocket, needle: str) -> bool:
    return any(needle in t for t in _texts(ws))


@pytest.fixture
def reset_manager() -> Iterator[None]:
    manager._connections.clear()
    yield
    manager._connections.clear()


@pytest.mark.asyncio
async def test_delivery_and_read_receipt_flow(
    monkeypatch: pytest.MonkeyPatch, reset_manager: None
) -> None:
    monkeypatch.setattr(TAKClient, "_get_ssl_context", lambda self: None)

    server = MockTakServer()
    srv = await asyncio.start_server(server.handle, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]

    ws_alice = FakeWebSocket("ws-alice")
    ws_bob = FakeWebSocket("ws-bob")
    await manager.connect(ws_alice, "alice")  # type: ignore[arg-type]
    await manager.connect(ws_bob, "bob")  # type: ignore[arg-type]

    def make_client(username: str, uid: str, callsign: str) -> TAKClient:
        from app.config import Settings

        client = TAKClient(
            config=Settings(tak_host="127.0.0.1", tak_port=port, use_msgpack=False),
            identity=Identity(
                username=username,
                uid=uid,
                callsign=callsign,
                color="",
                role="Team Member",
                server="127.0.0.1",
            ),
        )
        client.on_cot = client._broadcast_if_needed
        return client

    alice = make_client("alice", "UIDA", "ALPHA")
    bob = make_client("bob", "UIDB", "BRAVO")

    await alice.start()
    await bob.start()

    for _ in range(50):
        if len(server.connections) == 2:
            break
        await asyncio.sleep(0.1)
    assert len(server.connections) == 2
    await asyncio.sleep(0.3)

    try:
        # Alice DMs Bob with a fixed client_id (message_id).
        await alice.send_chat("All Chat Rooms", "UIDB", "BRAVO", "hi bob", "mid-1")
        await asyncio.sleep(0.5)

        # Bob's client automatically sent a b-t-f-d; the relay delivers it to
        # Alice, which surfaces a "delivered" chat_receipt on her socket.
        assert _contains(ws_alice, '"chat_receipt"')
        assert _contains(ws_alice, '"message_id": "mid-1"')
        assert _contains(ws_alice, '"status": "delivered"')

        # Bob never emits a read receipt until the user opens the thread.
        ws_bob.sent.clear()
        assert not _contains(ws_bob, "b-t-f-r")

        # The frontend signals chat_read -> Bob sends a b-t-f-r.
        bob_client = bob  # the running client, also in pool-less context
        await bob_client.send_chat_read("mid-1")
        await asyncio.sleep(0.5)
        assert _contains(ws_alice, '"status": "read"')

        # A second chat_read is deduplicated: no extra b-t-f-r for the same id.
        ws_alice.sent.clear()
        await bob_client.send_chat_read("mid-1")
        await asyncio.sleep(0.3)
        assert not _contains(ws_alice, '"status": "read"')
    finally:
        await alice.stop()
        await bob.stop()
        srv.close()
