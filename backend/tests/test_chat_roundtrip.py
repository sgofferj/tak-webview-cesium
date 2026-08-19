"""Two-client chat roundtrip over real sockets.

Spins up a mock TCP "TAK server" that relays every event to the other
connection, then drives two per-user TAKClients against it. Proves that a
chat sent by Alice reaches Bob's websocket (room + DM) and that Alice's own
websocket gets the self-mirror, with the user-scoped broadcast routing in
place.
"""

import asyncio
from collections.abc import Iterator

import pytest

from app.connection import manager
from app.tak_client import Identity, TAKClient

# pylint: disable=redefined-outer-name


class MockTakServer:
    """Relays any event from one connection to all other connections."""

    def __init__(self) -> None:
        self.connections: dict[str, asyncio.StreamWriter] = {}
        self.events: list[bytes] = []

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
                self.events.append(data)
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
async def test_chat_roundtrip_between_two_users(
    monkeypatch: pytest.MonkeyPatch, reset_manager: None
) -> None:
    from app.config import Settings

    monkeypatch.setattr(TAKClient, "_get_ssl_context", lambda self: None)

    server = MockTakServer()
    srv = await asyncio.start_server(server.handle, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]

    ws_alice = FakeWebSocket("ws-alice")
    ws_bob = FakeWebSocket("ws-bob")
    await manager.connect(ws_alice, "alice")  # type: ignore[arg-type]
    await manager.connect(ws_bob, "bob")  # type: ignore[arg-type]

    def make_client(username: str, uid: str, callsign: str, color: str) -> TAKClient:
        client = TAKClient(
            config=Settings(tak_host="127.0.0.1", tak_port=port, use_msgpack=False),
            identity=Identity(
                username=username,
                uid=uid,
                callsign=callsign,
                color=color,
                role="Team Member",
                server="127.0.0.1",
            ),
        )
        client.on_cot = client._broadcast_if_needed
        return client

    alice = make_client("alice", "CesiumViewer-alicehash", "ALPHA", "Red")
    bob = make_client("bob", "CesiumViewer-bobhash", "BRAVO", "Blue")

    await alice.start()
    await bob.start()

    for _ in range(50):
        if len(server.connections) == 2:
            break
        await asyncio.sleep(0.1)
    assert len(server.connections) == 2
    await asyncio.sleep(0.3)

    try:
        # Alice broadcasts to All Chat Rooms -> Bob must receive it.
        await alice.send_chat(
            "All Chat Rooms", None, None, "hello from alice", "room-1"
        )
        await asyncio.sleep(0.3)
        assert _contains(ws_bob, "hello from alice")
        assert _contains(ws_alice, "hello from alice")  # self-mirror

        # Alice DMs Bob -> Bob must receive it.
        await alice.send_chat(
            "All Chat Rooms", "CesiumViewer-bobhash", "BRAVO", "dm to bravo", "dm-1"
        )
        await asyncio.sleep(0.3)
        assert _contains(ws_bob, "dm to bravo")
    finally:
        await alice.stop()
        await bob.stop()
        srv.close()
