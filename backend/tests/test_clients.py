import pytest

from app.clients import ClientPool
from app.connection import ConnectionManager
from app.tak_client import Identity

# pylint: disable=redefined-outer-name


def make_identity(username: str, callsign: str | None = None) -> Identity:
    return Identity(
        username=username,
        uid=f"CesiumViewer-{username}",
        callsign=callsign or username,
        color="Red",
        role="Team Member",
        server="tak.example.com",
    )


def test_pool_creates_one_client_per_user() -> None:
    pool = ClientPool()
    alice = pool.client("tak.example.com", "alice", make_identity("alice"))
    alice2 = pool.client("tak.example.com", "alice", make_identity("alice"))
    bob = pool.client("tak.example.com", "bob", make_identity("bob"))

    assert alice is alice2  # same client reused per user
    assert alice is not bob
    assert pool.client_for("alice") is alice
    assert pool.client_for("bob") is bob
    assert pool.client_for("nobody") is None
    assert pool.is_running("alice") is False


def test_pool_refreshes_identity_on_same_user() -> None:
    pool = ClientPool()
    client = pool.client("tak.example.com", "alice", make_identity("alice"))
    updated = pool.client("tak.example.com", "alice", make_identity("alice", "NEWCALL"))
    assert client is updated
    assert client.identity.callsign == "NEWCALL"


@pytest.mark.asyncio
async def test_pool_stop_user_only_stops_that_user() -> None:
    pool = ClientPool()
    pool.client("tak.example.com", "alice", make_identity("alice"))
    bob = pool.client("tak.example.com", "bob", make_identity("bob"))
    await pool.stop_user("alice")
    assert pool.client_for("alice") is None
    assert pool.client_for("bob") is bob


def test_identity_changed_detects_differences() -> None:
    identity = make_identity("alice")
    assert identity.changed("alice", "Red", "Team Member") is False
    assert identity.changed("OTHER", "Red", "Team Member") is True
    assert identity.changed("alice", "Blue", "Team Member") is True
    assert identity.changed("alice", "Red", "HQ") is True


class FakeWebSocket:
    def __init__(self, name: str) -> None:
        self.name = name
        self.sent: list[str] = []
        self.client = None

    async def accept(self) -> None:
        pass

    async def send_text(self, message: str) -> None:
        self.sent.append(message)


@pytest.mark.asyncio
async def test_connection_manager_routes_per_user() -> None:
    manager = ConnectionManager()
    ws_alice = FakeWebSocket("alice-a")
    ws_alice2 = FakeWebSocket("alice-b")
    ws_bob = FakeWebSocket("bob")
    await manager.connect(ws_alice, "alice")  # type: ignore[arg-type]
    await manager.connect(ws_alice2, "alice")  # type: ignore[arg-type]
    await manager.connect(ws_bob, "bob")  # type: ignore[arg-type]

    await manager.broadcast("A", username="alice")
    assert ws_alice.sent == ["A"]
    assert ws_alice2.sent == ["A"]
    assert ws_bob.sent == []

    await manager.broadcast("B", username="bob")
    assert ws_bob.sent == ["B"]
    assert ws_alice.sent == ["A"]  # unchanged

    await manager.broadcast("ALL")
    assert ws_alice.sent == ["A", "ALL"]
    assert ws_alice2.sent == ["A", "ALL"]
    assert ws_bob.sent == ["B", "ALL"]

    assert manager.count_for("alice") == 2
    assert manager.count_for("bob") == 1
    manager.disconnect(ws_alice)  # type: ignore[arg-type]
    assert manager.count_for("alice") == 1
