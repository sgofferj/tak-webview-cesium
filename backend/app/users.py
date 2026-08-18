#!/usr/bin/env python3
# users.py - per-user registry and crypto primitives for the multiuser refactor.
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import base64
import hashlib
import json
import logging
import os
import secrets
from dataclasses import dataclass

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

logger = logging.getLogger("tak-webview.users")


@dataclass
class UserAccount:
    """Persisted per-user record; never holds plaintext secrets."""

    username: str
    pw_hash: str
    salt: str
    server: str
    cert_expiry: str | None = None


@dataclass
class UserSession:
    """Short-lived RAM-only handle holding the decrypted Fernet storage key."""

    username: str
    storage_key: bytes


class UserRegistry:
    """On-disk per-user storage under `<base>/users/<username>/`.

    The crypto primitives (PBKDF2, Fernet derivation, enrollment secrets)
    live here so the former single-record store becomes one record per user.
    """

    def __init__(self, base_dir: str) -> None:
        self.base_dir = base_dir
        self.users_dir = os.path.join(base_dir, "users")
        os.makedirs(self.users_dir, exist_ok=True)

    def user_dir(self, username: str) -> str:
        return os.path.join(self.users_dir, username)

    def derive_fernet_key(self, password: str, salt: str) -> bytes:
        """Derive a Fernet key from a password and salt."""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt.encode("utf-8"),
            iterations=100000,
        )
        return base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))

    def hash_password(self, password: str, salt: str | None = None) -> tuple[str, str]:
        if salt is None:
            salt = secrets.token_hex(16)
        pw_hash = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000
        ).hex()
        return pw_hash, salt

    def get_enrollment_secret(self, password: str, salt: str) -> str:
        """Deterministic but strong secret for the TAK enrollment CSR."""
        combined = f"{password}:{salt}:enrollment"
        return hashlib.sha256(combined.encode("utf-8")).hexdigest()[:16]

    def validate_password_strength(self, password: str, username: str) -> bool:
        """Minimum 8 chars, must not be 'atakatak', username, or empty."""
        if not password or len(password) < 8:
            return False
        if password.lower() in ["atakatak", username.lower()]:
            return False
        return True

    # ------------------------------------------------------------------
    #  Per-user record storage (used from Phase 2 on)
    # ------------------------------------------------------------------

    def _account_path(self, username: str) -> str:
        return os.path.join(self.user_dir(username), "account.json")

    def save_account(self, account: UserAccount) -> None:
        os.makedirs(self.user_dir(account.username), exist_ok=True)
        with open(self._account_path(account.username), "w", encoding="utf-8") as f:
            json.dump(
                {
                    "username": account.username,
                    "hash": account.pw_hash,
                    "salt": account.salt,
                    "server": account.server,
                    "cert_expiry": account.cert_expiry,
                },
                f,
            )

    def get_account(self, username: str) -> UserAccount | None:
        try:
            with open(self._account_path(username), encoding="utf-8") as f:
                data = json.load(f)
            return UserAccount(
                username=str(data.get("username", "")),
                pw_hash=str(data.get("hash", "")),
                salt=str(data.get("salt", "")),
                server=str(data.get("server", "")),
                cert_expiry=(
                    str(data["cert_expiry"]) if data.get("cert_expiry") else None
                ),
            )
        except (OSError, json.JSONDecodeError):
            return None

    def delete_account(self, username: str) -> None:
        path = self._account_path(username)
        if os.path.exists(path):
            os.remove(path)

    def list_accounts(self) -> list[UserAccount]:
        accounts: list[UserAccount] = []
        if not os.path.isdir(self.users_dir):
            return accounts
        for name in sorted(os.listdir(self.users_dir)):
            account = self.get_account(name)
            if account:
                accounts.append(account)
        return accounts

    def verify_credentials(self, username: str, password: str) -> UserSession | None:
        """Authenticate against the registry; returns a RAM-only session."""
        account = self.get_account(username)
        if not account:
            return None
        check_hash, _ = self.hash_password(password, account.salt)
        if secrets.compare_digest(check_hash, account.pw_hash):
            storage_key = self.derive_fernet_key(password, account.salt)
            return UserSession(username=username, storage_key=storage_key)
        return None

    def any_certificates_remain(self) -> bool:
        """True when any per-user certificate still exists on disk.

        Used to decide whether wiping this user was the *last* certificate,
        which resets the pinned server (single-server pinning).
        """
        if not os.path.isdir(self.users_dir):
            return False
        for name in os.listdir(self.users_dir):
            if os.path.exists(os.path.join(self.user_dir(name), "cert.pem")):
                return True
        return False


def encrypt_key_blob(storage_key: bytes, key_bytes: bytes) -> bytes:
    """Fernet-encrypt a private key blob for at-rest storage."""
    return Fernet(storage_key).encrypt(key_bytes)


def decrypt_key_blob(storage_key: bytes, blob: bytes) -> bytes:
    """Decrypt a Fernet-encrypted private key blob into RAM."""
    decrypted = Fernet(storage_key).decrypt(blob)
    return bytes(decrypted) if decrypted is not None else b""
