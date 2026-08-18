import types

import pytest

from app import auth as auth_module
from app.auth import AuthManager

# pylint: disable=redefined-outer-name


@pytest.fixture
def manager(tmp_path: object, monkeypatch: pytest.MonkeyPatch) -> AuthManager:
    fake_settings = types.SimpleNamespace(
        ephemeral_dir=str(tmp_path),
        ephemeral_creds="creds.json",
        ephemeral_cert="cert.pem",
        ephemeral_key="cert.key",
        ephemeral_ca="ca.pem",
        force_server=None,
    )
    monkeypatch.setattr(auth_module, "settings", fake_settings)
    return AuthManager()


def test_first_user_decides_server(manager: AuthManager) -> None:
    ok, server = manager.decide_server("tak.example.com")
    assert ok is True
    assert server == "tak.example.com"


def test_no_server_rejected_before_pin(manager: AuthManager) -> None:
    ok, server = manager.decide_server("")
    assert ok is False
    assert server is None


def test_pinned_server_mismatch_rejected(manager: AuthManager) -> None:
    manager.pin_server("tak.example.com")
    ok, server = manager.decide_server("other.tak.example.com")
    assert ok is False
    assert server is None


def test_pinned_server_match_accepted(manager: AuthManager) -> None:
    manager.pin_server("tak.example.com")
    ok, server = manager.decide_server("tak.example.com")
    assert ok is True
    assert server == "tak.example.com"


def test_empty_request_resolves_to_pinned(manager: AuthManager) -> None:
    manager.pin_server("tak.example.com")
    ok, server = manager.decide_server("")
    assert ok is True
    assert server == "tak.example.com"


def test_pin_persisted(manager: AuthManager) -> None:
    manager.pin_server("tak.example.com")
    assert manager.get_pinned_server() == "tak.example.com"
    assert AuthManager().get_pinned_server() == "tak.example.com"


def test_pin_reset_on_wipe_without_force(manager: AuthManager) -> None:
    manager.pin_server("tak.example.com")
    manager.wipe_ephemeral()
    assert manager.get_pinned_server() is None


def test_pin_kept_on_wipe_with_force(
    manager: AuthManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager.pin_server("tak.example.com")
    fake_settings = types.SimpleNamespace(
        ephemeral_dir=manager.ephemeral_dir,
        ephemeral_creds="creds.json",
        ephemeral_cert="cert.pem",
        ephemeral_key="cert.key",
        ephemeral_ca="ca.pem",
        force_server="forced.tak.example",
    )
    monkeypatch.setattr(auth_module, "settings", fake_settings)
    manager.wipe_ephemeral()
    assert manager.get_pinned_server() == "tak.example.com"


@pytest.mark.parametrize(
    ("requested", "expected_ok"),
    [
        ("forced.tak.example", True),
        ("", True),
        ("other.tak.example", False),
    ],
)
def test_force_server_wins(
    manager: AuthManager,
    monkeypatch: pytest.MonkeyPatch,
    requested: str,
    expected_ok: bool,
) -> None:
    fake_settings = types.SimpleNamespace(
        ephemeral_dir=manager.ephemeral_dir,
        ephemeral_creds="creds.json",
        ephemeral_cert="cert.pem",
        ephemeral_key="cert.key",
        ephemeral_ca="ca.pem",
        force_server="forced.tak.example",
    )
    monkeypatch.setattr(auth_module, "settings", fake_settings)
    ok, server = manager.decide_server(requested)
    assert ok is expected_ok
    if expected_ok:
        assert server == "forced.tak.example"
    else:
        assert server is None
