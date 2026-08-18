import os

import pytest

from app.users import UserAccount, UserRegistry, UserSession

# pylint: disable=redefined-outer-name


@pytest.fixture
def registry(tmp_path: object) -> UserRegistry:
    return UserRegistry(str(tmp_path))


def test_crypto_roundtrip(registry: UserRegistry) -> None:
    pw_hash, salt = registry.hash_password("correct horse battery staple")
    assert pw_hash != "correct horse battery staple"
    assert salt
    key = registry.derive_fernet_key("correct horse battery staple", salt)
    assert len(key) == 44  # urlsafe_b64 of a 32-byte key


def test_enrollment_secret_deterministic(registry: UserRegistry) -> None:
    secret = registry.get_enrollment_secret("pw", "salt")
    assert secret == registry.get_enrollment_secret("pw", "salt")
    assert len(secret) == 16


def test_password_strength(registry: UserRegistry) -> None:
    assert not registry.validate_password_strength("short", "joe")
    assert not registry.validate_password_strength("atakatak", "joe")
    assert not registry.validate_password_strength("JOE", "joe")
    assert registry.validate_password_strength("long-enough-pass", "joe")


def test_save_and_get_account(registry: UserRegistry) -> None:
    account = UserAccount(
        username="joe",
        pw_hash="h",
        salt="s",
        server="tak.example.com",
        cert_expiry="2026-12-31",
    )
    registry.save_account(account)
    loaded = registry.get_account("joe")
    assert loaded is not None
    assert loaded.username == "joe"
    assert loaded.server == "tak.example.com"
    assert loaded.cert_expiry == "2026-12-31"
    assert registry.get_account("nobody") is None


def test_delete_account(registry: UserRegistry) -> None:
    registry.save_account(
        UserAccount(username="joe", pw_hash="h", salt="s", server="t")
    )
    registry.delete_account("joe")
    assert registry.get_account("joe") is None


def test_verify_credentials(registry: UserRegistry) -> None:
    pw = "correct horse battery staple"
    pw_hash, salt = registry.hash_password(pw)
    registry.save_account(
        UserAccount(username="joe", pw_hash=pw_hash, salt=salt, server="t")
    )
    session = registry.verify_credentials("joe", pw)
    assert isinstance(session, UserSession)
    assert session.username == "joe"
    assert registry.verify_credentials("joe", "wrong password") is None
    assert registry.verify_credentials("nobody", pw) is None


def test_any_certificates_remain(registry: UserRegistry) -> None:
    assert registry.any_certificates_remain() is False
    cert_path = os.path.join(registry.user_dir("joe"), "cert.pem")
    os.makedirs(os.path.dirname(cert_path), exist_ok=True)
    with open(cert_path, "w", encoding="utf-8") as f:
        f.write("dummy")
    assert registry.any_certificates_remain() is True
    os.remove(cert_path)
    assert registry.any_certificates_remain() is False