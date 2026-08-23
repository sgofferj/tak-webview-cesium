# Channel subscription endpoint and helper tests.
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.auth import auth_manager
from app.connection import tracker
from app.groups import channels_from_entitlements
from app.main import app


def _ent(name: str, direction: str, active: bool) -> dict[str, Any]:
    return {
        "name": name,
        "direction": direction,
        "created": "2026-01-01",
        "type": "SYSTEM",
        "bitpos": 1,
        "active": active,
    }


def test_channels_from_entitlements_merges_directions() -> None:
    ents = [
        _ent("Alpha", "IN", True),
        _ent("Alpha", "OUT", True),
        _ent("Beta", "IN", False),
        _ent("Beta", "OUT", True),
        _ent("Gamma", "OUT", True),
    ]
    channels = channels_from_entitlements(ents)
    assert channels == [
        {"name": "Alpha", "subscribed": True},
        # IN+OUT must both be active for the checkbox to be subscribed
        {"name": "Beta", "subscribed": False},
        {"name": "Gamma", "subscribed": True},
    ]


def test_channels_from_entitlements_empty() -> None:
    assert channels_from_entitlements([]) == []


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(tracker, "username_for", lambda _sid: "alice")
    return TestClient(app)


def test_list_channels_unauthenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracker, "username_for", lambda _sid: None)
    with TestClient(app) as tc:
        resp = tc.get("/api/channels")
    assert resp.status_code == 401


def test_update_channels_unauthenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracker, "username_for", lambda _sid: None)
    with TestClient(app) as tc:
        resp = tc.put("/api/channels", json={"channels": ["Alpha"]})
    assert resp.status_code == 401


def test_list_channels(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_get_channels(server: str, username: str) -> list[dict[str, Any]]:
        assert server == "tak.example.test"
        assert username == "alice"
        return [{"name": "Alpha", "subscribed": True}]

    monkeypatch.setattr(main_mod, "get_channels", fake_get_channels)
    monkeypatch.setattr(auth_manager, "user_server", lambda _u: "tak.example.test")
    resp = client.get("/api/channels")
    assert resp.status_code == 200
    assert resp.json() == {"channels": [{"name": "Alpha", "subscribed": True}]}


def test_update_channels(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_set(server: str, username: str, names: set[str]) -> None:
        captured["server"] = server
        captured["username"] = username
        captured["names"] = names

    monkeypatch.setattr(main_mod, "set_subscribed_channels", fake_set)
    resp = client.put("/api/channels", json={"channels": ["Alpha", "", "Beta "]})
    assert resp.status_code == 200
    assert captured["names"] == {"Alpha", "Beta"}
    assert captured["username"] == "alice"


def test_update_channels_invalid_body(client: TestClient) -> None:
    resp = client.put("/api/channels", json={"channels": [1, 2]})
    assert resp.status_code == 400
