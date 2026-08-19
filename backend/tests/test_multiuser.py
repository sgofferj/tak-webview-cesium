import types

import pytest

from app import auth as auth_module
from app.auth import AuthManager
from app.connection import SessionTracker
from app.users import (
    decrypt_key_blob,
    encrypt_key_blob,
    uid_for_username,
)

# pylint: disable=redefined-outer-name


@pytest.fixture
def tracker() -> SessionTracker:
    return SessionTracker()


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


# ----------------------------------------------------------------------
#  Per-user identity helpers
# ----------------------------------------------------------------------


def test_uid_for_username_stable_and_distinct() -> None:
    uid_a = uid_for_username("alice")
    assert uid_a == uid_for_username("alice")
    assert uid_a.startswith("CesiumViewer-")
    assert uid_for_username("alice") != uid_for_username("bob")


def test_key_blob_roundtrip() -> None:
    from cryptography.fernet import Fernet

    storage_key = Fernet.generate_key()
    plaintext = b"PRIVATE KEY MATERIAL"
    blob = encrypt_key_blob(storage_key, plaintext)
    assert blob != plaintext
    assert decrypt_key_blob(storage_key, blob) == plaintext


# ----------------------------------------------------------------------
#  UserRegistry per-user isolation
# ----------------------------------------------------------------------


def test_per_user_cert_storage_is_isolated(manager: AuthManager) -> None:
    registry = manager.registry
    registry.save_cert("alice", b"ALICE-CERT")
    registry.save_cert("bob", b"BOB-CERT")
    registry.save_ca("alice", b"ALICE-CA")
    registry.save_encrypted_key("alice", b"ALICE-KEY")

    assert registry.load_cert("alice") == b"ALICE-CERT"
    assert registry.load_cert("bob") == b"BOB-CERT"
    assert registry.load_ca("alice") == b"ALICE-CA"
    assert registry.load_ca("bob") is None
    assert registry.load_encrypted_key("alice") == b"ALICE-KEY"
    assert registry.load_encrypted_key("bob") is None


def test_delete_user_removes_only_that_user(manager: AuthManager) -> None:
    registry = manager.registry
    registry.save_cert("alice", b"A")
    registry.save_cert("bob", b"B")
    registry.delete_user("alice")
    assert registry.load_cert("alice") is None
    assert registry.load_cert("bob") == b"B"
    assert registry.count() == 0  # no account records were saved


# ----------------------------------------------------------------------
#  SessionTracker sid <-> user mapping
# ----------------------------------------------------------------------


def test_tracker_registers_and_unregisters(tracker: SessionTracker) -> None:
    tracker.register("sid1", "alice")
    tracker.register("sid2", "alice")
    tracker.register("sid3", "bob")
    assert tracker.username_for("sid1") == "alice"
    assert tracker.username_for("sid2") == "alice"
    assert tracker.username_for("sid3") == "bob"
    assert tracker.username_for("unknown") is None

    assert tracker.unregister("sid1") == "alice"
    assert tracker.sessions_for("alice") == {"sid2"}
    assert tracker.unregister("sid2") == "alice"
    assert tracker.sessions_for("alice") == set()
    assert tracker.username_for("sid2") is None


def test_tracker_websocket_lifecycle(tracker: SessionTracker) -> None:
    tracker.register("sid1", "alice")
    assert tracker.active is False
    tracker.ws_opened("sid1")
    tracker.ws_opened("sid1")
    assert tracker.active is True
    tracker.ws_closed("sid1")
    assert tracker.active is True  # second tab still open
    tracker.ws_closed("sid1")
    assert tracker.active is False


# ----------------------------------------------------------------------
#  AuthManager multi-user behaviour
# ----------------------------------------------------------------------


def _save_user(manager: AuthManager, username: str, server: str) -> None:
    pw_hash, salt = manager.registry.hash_password("long-enough-pass")
    from app.users import UserAccount

    manager.registry.save_account(
        UserAccount(
            username=username,
            pw_hash=pw_hash,
            salt=salt,
            server=server,
            uid=uid_for_username(username),
        )
    )
    manager.registry.save_cert(username, f"{username}-CERT".encode())


def test_login_activates_user_and_scopes_server(manager: AuthManager) -> None:
    _save_user(manager, "alice", "tak.example.com")
    _save_user(manager, "bob", "tak.example.com")

    assert manager.active_user is None
    assert manager.login("alice", "long-enough-pass") is True
    assert manager.active_user == "alice"
    assert manager.user_server("alice") == "tak.example.com"
    assert manager.user_server("bob") == "tak.example.com"
    assert manager.user_server("nobody") is None
    assert manager.enrolled_server == "tak.example.com"

    # Switching user keeps both enrolled but changes the active user
    assert manager.login("bob", "long-enough-pass") is True
    assert manager.active_user == "bob"
    assert manager.is_user_enrolled("alice") is True
    assert manager.is_user_enrolled("bob") is True
    assert manager.is_user_enrolled("nobody") is False


def test_is_enrolled_any_user(manager: AuthManager) -> None:
    assert manager.is_enrolled() is False
    _save_user(manager, "alice", "tak.example.com")
    assert manager.is_enrolled() is True


def test_drop_session_deactivates_active_user(manager: AuthManager) -> None:
    _save_user(manager, "alice", "tak.example.com")
    manager.login("alice", "long-enough-pass")
    assert manager.session_for("alice") is not None
    manager.drop_session("alice")
    assert manager.session_for("alice") is None
    assert manager.active_user is None


def test_wipe_user_isolated(manager: AuthManager) -> None:
    _save_user(manager, "alice", "tak.example.com")
    _save_user(manager, "bob", "tak.example.com")
    manager.wipe_user("alice")
    assert manager.is_user_enrolled("alice") is False
    assert manager.is_user_enrolled("bob") is True
    assert manager.registry.load_cert("alice") is None
    assert manager.registry.load_cert("bob") is not None


def test_failed_login_counters_per_user(manager: AuthManager) -> None:
    manager.record_failed_login("alice")
    manager.record_failed_login("alice")
    manager.record_failed_login("bob")
    assert manager.record_failed_login("alice") == 3
    assert manager.record_failed_login("bob") == 2
    manager.reset_failed_logins("alice")
    assert manager.record_failed_login("alice") == 1
