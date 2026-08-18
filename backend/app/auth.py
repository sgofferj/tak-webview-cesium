#!/usr/bin/env python3
# auth.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import io
import json
import logging
import os
import zipfile
from datetime import UTC, datetime
from typing import Any

import httpx
from cryptography import x509
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from lxml import etree

from .config import settings
from .users import UserRegistry, uid_for_username

logger = logging.getLogger("tak-webview.auth")


class AuthManager:
    def __init__(self) -> None:
        self.ephemeral_dir = settings.ephemeral_dir
        self.pinned_server_file = os.path.join(self.ephemeral_dir, "pinned_server.json")
        self.registry = UserRegistry(self.ephemeral_dir)

        os.makedirs(self.ephemeral_dir, exist_ok=True)
        # RAM-only per-user storage keys (decrypted Fernet keys), keyed by username
        self._sessions: dict[str, Any] = {}
        # One-shot enrollment profiles per user (callsign/color/role from
        # the TAK server)
        self._enrollment_profiles: dict[str, dict[str, str]] = {}
        # Per-user failed login counters
        self._failed_attempts: dict[str, int] = {}
        # The user currently driving the single TAK connection
        self.active_user: str | None = None

    @property
    def enrollment_profile(self) -> dict[str, str]:
        """Callsign/color/role from the last successful enrollment profile."""
        username = self.active_user
        if not username:
            return {"callsign": "", "color": "", "role": ""}
        return self._enrollment_profiles.get(
            username, {"callsign": "", "color": "", "role": ""}
        )

    def get_pinned_server(self) -> str | None:
        """The install-level TAK server chosen by the first enrollment/upload."""
        try:
            with open(self.pinned_server_file, encoding="utf-8") as f_in:
                data = json.load(f_in)
            server = data.get("server")
            return str(server) if server else None
        except (OSError, json.JSONDecodeError):
            return None

    def pin_server(self, server: str) -> None:
        """Persist the install-level server chosen by the first user."""
        had_pin = self.get_pinned_server() is not None
        with open(self.pinned_server_file, "w", encoding="utf-8") as f_out:
            json.dump({"server": server}, f_out)
        if not had_pin:
            logger.info("First enrollment succeeded, pinned server to %s", server)

    def decide_server(self, requested: str) -> tuple[bool, str | None]:
        """Enforce single-server pinning; returns (ok, effective_server).

        `FORCE_SERVER` always wins. Otherwise the first successful enrollment
        or certificate upload pins the server; later requests must match it.
        """
        if settings.force_server:
            if requested and requested != settings.force_server:
                return False, None
            return True, settings.force_server
        pinned = self.get_pinned_server()
        if pinned:
            if requested and requested != pinned:
                return False, None
            return True, pinned
        if not requested:
            return False, None
        return True, requested

    def _derive_fernet_key(self, password: str, salt: str) -> bytes:
        """Derive a Fernet key from a password and salt (registry crypto)."""
        return self.registry.derive_fernet_key(password, salt)

    def hash_password(self, password: str, salt: str | None = None) -> tuple[str, str]:
        """PBKDF2 hash + salt (registry crypto)."""
        return self.registry.hash_password(password, salt)

    def _get_enrollment_secret(self, password: str, salt: str) -> str:
        """Deterministic but strong secret for the TAK enrollment CSR."""
        return self.registry.get_enrollment_secret(password, salt)

    def validate_password_strength(self, password: str, username: str) -> bool:
        """Minimum 8 chars, must not be 'atakatak', username, or empty."""
        return self.registry.validate_password_strength(password, username)

    def upload_p12(
        self,
        p12_data: bytes,
        current_password: str,
        new_password: str | None = None,
        server: str = "imported",
    ) -> str | None:
        """
        Process a .p12 certificate upload.
        Extracts username from Certificate CN. Returns username on success.
        """
        # pylint: disable=too-many-locals,too-many-arguments
        from cryptography.hazmat.primitives.serialization import pkcs12

        try:
            # 1. Decrypt P12
            p12_password = (
                current_password.encode("utf-8") if current_password else None
            )
            private_key, certificate, additional_certificates = (
                pkcs12.load_key_and_certificates(p12_data, p12_password)
            )

            if not private_key or not certificate:
                logger.error("P12 file missing private key or certificate")
                return None

            # 2. Extract Username from CN
            username = certificate.subject.get_attributes_for_oid(
                x509.NameOID.COMMON_NAME
            )[0].value
            if not isinstance(username, str):
                username = str(username)

            # 3. Security Check
            insecure = not self.validate_password_strength(current_password, username)
            if insecure:
                if not new_password or not self.validate_password_strength(
                    new_password, username
                ):
                    logger.error(
                        "Insecure P12 password and no valid new password provided"
                    )
                    return None
                final_password = new_password
            else:
                final_password = current_password

            # Save everything in our format (per-user, key encrypted at rest)
            _, salt = self.hash_password(final_password)
            storage_key = self._derive_fernet_key(final_password, salt)

            # Encrypt private key
            key_bytes = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            encrypted_key_blob = Fernet(storage_key).encrypt(key_bytes)

            # Convert certificate to PEM
            cert_pem = certificate.public_bytes(serialization.Encoding.PEM)
            expiry = certificate.not_valid_after_utc.isoformat()

            self.registry.save_cert(username, cert_pem)
            self.registry.save_encrypted_key(username, encrypted_key_blob)
            if additional_certificates:
                ca_pem = (
                    b"\n".join(
                        ca.public_bytes(serialization.Encoding.PEM)
                        for ca in additional_certificates
                    )
                    + b"\n"
                )
                self.registry.save_ca(username, ca_pem)

            self._save_user_credentials(
                username,
                final_password,
                server,
                salt,
                expiry,
                uid_for_username(username),
            )
            self.pin_server(server)
            self.login(username, final_password)
            self.reset_failed_logins(username)
            self._enrollment_profiles[username] = {
                "callsign": "",
                "color": "",
                "role": "",
            }
            logger.info("P12 upload for user '%s' successful", username)
            return username

        except Exception as e:
            logger.error("P12 import error: %s: %s", type(e).__name__, e)
            return None

    # ------------------------------------------------------------------
    #  Per-user account storage and RAM-only sessions
    # ------------------------------------------------------------------

    def _save_user_credentials(
        self,
        username: str,
        password: str,
        server: str,
        salt: str | None,
        cert_expiry: str | None,
        uid: str,
    ) -> None:
        """Persist the per-user account record (hash + salt + server + UID).

        The storage key is derived from the password and kept in RAM only.
        """
        from .users import UserAccount

        pw_hash, salt = self.hash_password(password, salt)
        self.registry.save_account(
            UserAccount(
                username=username,
                pw_hash=pw_hash,
                salt=salt,
                server=server,
                cert_expiry=cert_expiry,
                uid=uid,
            )
        )

    def _activate(self, username: str, uid: str) -> None:
        """Make `username` the user driving the single TAK connection."""
        prev = self.active_user
        self.active_user = username
        settings.tak_uid = uid
        if prev != username:
            # Switching users must not carry over the previous user's identity
            self._reset_runtime_identity()

    def _deactivate(self) -> None:
        """Clear the active user so the TAK client cannot start/resume."""
        self.active_user = None
        settings.tak_uid = None
        self._reset_runtime_identity()

    @staticmethod
    def _reset_runtime_identity() -> None:
        settings.tak_callsign_input = ""
        settings.tak_color = ""
        settings.tak_role = ""

    def activate_user(self, username: str | None) -> None:
        """Make `username` the active user (after their messaging config is set)."""
        if not username:
            return
        account = self.registry.get_account(username)
        uid = account.uid if account and account.uid else uid_for_username(username)
        self._activate(username, uid)

    def login(self, username: str, password: str) -> bool:
        """Authenticate against the registry.

        On success a RAM-only UserSession (decrypted key) is created and the
        user is activated on the single connection.
        """
        session = self.registry.verify_credentials(username, password)
        if not session:
            return False
        self._sessions[username] = session
        account = self.registry.get_account(username)
        uid = account.uid if account and account.uid else uid_for_username(username)
        self._activate(username, uid)
        return True

    def drop_session(self, username: str) -> None:
        """Drop the RAM-only storage key when the user's last session ends."""
        self._sessions.pop(username, None)
        if self.active_user == username:
            self._deactivate()

    def session_for(self, username: str) -> Any | None:
        return self._sessions.get(username)

    def is_user_enrolled(self, username: str | None) -> bool:
        if not username:
            return False
        return self.registry.get_account(username) is not None

    def is_enrolled(self) -> bool:
        """Any user is enrolled in this install."""
        return self.registry.count() > 0

    def user_server(self, username: str | None) -> str | None:
        if not username:
            return None
        account = self.registry.get_account(username)
        return account.server if account and account.server else None

    def record_failed_login(self, username: str | None) -> int:
        if not username:
            return 0
        self._failed_attempts[username] = self._failed_attempts.get(username, 0) + 1
        return self._failed_attempts[username]

    def reset_failed_logins(self, username: str | None) -> None:
        if username:
            self._failed_attempts.pop(username, None)

    @property
    def enrolled_server(self) -> str | None:
        """The active user's TAK server (single connection)."""
        return self.user_server(self.active_user)

    def _ensure_pem_headers(self, cert_str: str, tag: str = "CERTIFICATE") -> bytes:
        cert_str = (cert_str or "").strip()
        if not cert_str:
            return b""

        header = f"-----BEGIN {tag}-----"
        footer = f"-----END {tag}-----"
        if not cert_str.startswith("-----BEGIN"):
            cert_str = f"{header}\n{cert_str}\n{footer}"
        return cert_str.encode("utf-8")

    def get_cert_bytes(self, username: str | None = None) -> bytes | None:
        """The active (or named) user's certificate, for the TLS chain."""
        name = username or self.active_user
        if not name:
            return None
        return self.registry.load_cert(name)

    def get_ca_bytes(self, username: str | None = None) -> bytes | None:
        """The active (or named) user's CA bundle, for server verification."""
        name = username or self.active_user
        if not name:
            return None
        return self.registry.load_ca(name)

    def get_cert_info(self, username: str | None = None) -> dict[str, Any] | None:
        username = username or self.active_user
        if not username:
            return None
        cert_data = self.registry.load_cert(username)
        if not cert_data:
            return None

        try:
            cert = x509.load_pem_x509_certificate(cert_data)
            cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
            org_attrs = cert.subject.get_attributes_for_oid(
                x509.NameOID.ORGANIZATION_NAME
            )
            org = str(org_attrs[0].value) if org_attrs else None
            expiry = cert.not_valid_after_utc

            now = datetime.now(UTC)
            status = "green"
            delta = expiry - now
            if delta.days < 0:
                status = "expired"
            elif delta.days < 3:
                status = "red"
            elif delta.days < 7:
                status = "orange"

            return {
                "cn": cn,
                "org": org,
                "expiry": expiry.isoformat(),
                "status": status,
                "days_left": delta.days,
            }
        except Exception as e:
            logger.error("Failed to read cert info: %s", e)
            return None

    def get_private_key(self, username: str | None = None) -> bytes | None:
        """Decrypt the user's private key into RAM using their RAM-only key."""
        username = username or self.active_user
        if not username:
            logger.error("No active user for private key")
            return None
        encrypted_key = self.registry.load_encrypted_key(username)
        if not encrypted_key:
            logger.error("Private key file missing for user '%s' on disk", username)
            return None
        session = self._sessions.get(username)
        if not session:
            logger.error("No RAM session for user '%s' (not logged in?)", username)
            return None

        try:
            decrypted = Fernet(session.storage_key).decrypt(encrypted_key)
            return bytes(decrypted) if decrypted is not None else None
        except Exception as e:
            logger.error(
                "Failed to decrypt private key in RAM: %s: %s", type(e).__name__, e
            )
            return None

    async def _fetch_enrollment_profile(
        self, client: httpx.AsyncClient, base_url: str, uid: str, auth: httpx.BasicAuth
    ) -> dict[str, str]:
        """Fetch and parse the enrollment-time device profile from the server.

        After signClient, the TAK Server can push a mission package containing
        a user-profile.pref with locationCallsign/locationTeam/atakRoleType.
        Returns ""-valued dict when the server has no profile for this user.
        """
        try:
            resp = await client.get(
                f"{base_url}/profile/enrollment",
                params={"clientUid": uid},
                auth=auth,
                follow_redirects=True,
            )
            if resp.status_code != 200:
                logger.info(
                    "No enrollment profile (status %s) for uid %s",
                    resp.status_code,
                    uid,
                )
                return {}

            profile = self._parse_profile_package(resp.content)
            logger.info("Enrollment profile for %s: %s", uid, profile)
            return profile
        except Exception as e:
            logger.warning("Failed to fetch enrollment profile: %s", e)
            return {}

    def _parse_profile_package(self, data: bytes) -> dict[str, str]:
        """Extract callsign/color/role from a profile.zip mission package."""
        callsign = ""
        color = ""
        role = ""
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for name in zf.namelist():
                    if not name.lower().endswith(".pref"):
                        continue
                    try:
                        root = etree.fromstring(zf.read(name))
                    except etree.XMLSyntaxError:
                        continue
                    for entry in root.xpath("//*[local-name()='entry']"):
                        key = entry.get("key")
                        if entry.text:
                            value = entry.text.strip()
                            if key == "locationCallsign" and callsign == "":
                                callsign = value
                            elif key == "locationTeam" and color == "":
                                color = value
                            elif key == "atakRoleType" and role == "":
                                role = value
        except (zipfile.BadZipFile, zipfile.LargeZipFile) as e:
            logger.warning("Profile package is not a valid zip: %s", e)
        return {"callsign": callsign, "color": color, "role": role}

    async def enroll(self, server: str, username: str, password: str) -> bool:
        """Enroll the client with a TAK server."""
        # pylint: disable=too-many-locals,too-many-branches,too-many-statements
        uid = uid_for_username(username)
        base_url = f"https://{server}:{settings.tak_enroll_port}/Marti/api/tls"

        # Initialize salt early for enrollment secret derivation
        _, salt = self.hash_password(password)
        enrollment_secret = self._get_enrollment_secret(password, salt)

        try:
            # 1. Generate Key Pair (Needed for CSR)
            temp_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

            async with httpx.AsyncClient(verify=False) as client:
                # 2. Get Config
                auth = httpx.BasicAuth(username, password)
                config_resp = await client.get(f"{base_url}/config", auth=auth)

                if config_resp.status_code != 200:
                    logger.error("Config request failed: %s", config_resp.status_code)
                    return False

                # 3. Parse Config for OIDs
                config_root = etree.fromstring(config_resp.content)
                name_entries = []
                for entry in config_root.xpath("//*[local-name()='nameEntry']"):
                    name = entry.get("name")
                    value = entry.get("value")
                    if name and value:
                        name_entries.append((name, value))

                oid_map = {
                    "CN": x509.NameOID.COMMON_NAME,
                    "O": x509.NameOID.ORGANIZATION_NAME,
                    "OU": x509.NameOID.ORGANIZATIONAL_UNIT_NAME,
                    "C": x509.NameOID.COUNTRY_NAME,
                    "ST": x509.NameOID.STATE_OR_PROVINCE_NAME,
                    "L": x509.NameOID.LOCALITY_NAME,
                }

                subject_items = [x509.NameAttribute(x509.NameOID.COMMON_NAME, username)]
                for name, value in name_entries:
                    if name in oid_map and name != "CN":
                        subject_items.append(x509.NameAttribute(oid_map[name], value))

                # 4. Generate CSR
                csr = (
                    x509.CertificateSigningRequestBuilder()
                    .subject_name(x509.Name(subject_items))
                    .sign(temp_key, hashes.SHA256())
                )
                csr_pem = csr.public_bytes(serialization.Encoding.PEM)
                csr_body = (
                    csr_pem.decode("utf-8")
                    .replace("-----BEGIN CERTIFICATE REQUEST-----", "")
                    .replace("-----END CERTIFICATE REQUEST-----", "")
                    .strip()
                    .encode("utf-8")
                )

                # 5. Sign Client (Using our hidden enrollment secret as password)
                sign_url = (
                    f"{base_url}/signClient/v2?clientUid={uid}"
                    f"&version=4.10.0&token={enrollment_secret}"
                )
                headers = {
                    "Accept": "application/xml",
                    "Content-Type": "application/octet-stream",
                }

                sign_resp = await client.post(
                    sign_url, auth=auth, content=csr_body, headers=headers
                )

                if sign_resp.status_code != 200:
                    logger.error("Signing failed: %s", sign_resp.status_code)
                    return False

                # 6. Parse XML Response
                root = etree.fromstring(sign_resp.content)
                client_cert_pem = None
                raw_private_key = None
                ca_certs = []

                for child in root:
                    tag_name = child.tag
                    if isinstance(tag_name, str) and "}" in tag_name:
                        tag_name = tag_name.split("}")[1]
                    elif hasattr(tag_name, "text"):
                        # Handle QName or other objects that might have text
                        tag_name = str(tag_name)

                    if tag_name == "signedCert":
                        client_cert_pem = self._ensure_pem_headers(
                            str(child.text or "")
                        )
                    elif tag_name == "privateKey":
                        # Decrypt what the server sent using our enrollment secret
                        server_key_pem = self._ensure_pem_headers(
                            str(child.text or ""), "ENCRYPTED PRIVATE KEY"
                        )
                        raw_private_key = serialization.load_pem_private_key(
                            server_key_pem, password=enrollment_secret.encode("utf-8")
                        )
                    else:
                        ca_certs.append(self._ensure_pem_headers(str(child.text or "")))

                if not raw_private_key:
                    logger.info("Server did not provide private key, using local temp")
                    raw_private_key = temp_key

                if not client_cert_pem:
                    logger.error("No signedCert found in response")
                    return False

                # 7. Final Protection: Encrypt the key with our hidden STORAGE_KEY
                storage_key = self._derive_fernet_key(password, salt)
                key_bytes = raw_private_key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption(),
                )
                encrypted_key_blob = Fernet(storage_key).encrypt(key_bytes)

                # Store per-user
                self.registry.save_encrypted_key(username, encrypted_key_blob)
                self.registry.save_cert(username, client_cert_pem)
                if ca_certs:
                    ca_pem = b"\n".join(ca_certs) + b"\n"
                    self.registry.save_ca(username, ca_pem)

                try:
                    cert = x509.load_pem_x509_certificate(client_cert_pem)
                    cert_expiry = cert.not_valid_after_utc.isoformat()
                except Exception:
                    cert_expiry = None

                self._save_user_credentials(
                    username, password, server, salt, cert_expiry, uid
                )
                self.pin_server(server)
                self.login(username, password)
                self.reset_failed_logins(username)

                # Fetch the enrollment-time device profile (callsign/color/role)
                # and keep it for the frontend to prefill the config popup.
                profile = await self._fetch_enrollment_profile(
                    client, base_url, uid, auth
                )
                self._enrollment_profiles[username] = profile or {
                    "callsign": "",
                    "color": "",
                    "role": "",
                }

                logger.info("Enrollment successful")
                return True

        except Exception as e:
            logger.error("Enrollment error: %s", e)
            return False

    def _reset_pin_if_last_cert(self) -> None:
        """Reset the pinned server once the last certificate is gone.

        FORCE_SERVER keeps the pin forever.
        """
        if (
            not settings.force_server
            and not self.registry.any_certificates_remain()
            and os.path.exists(self.pinned_server_file)
        ):
            os.remove(self.pinned_server_file)

    def wipe_user(self, username: str | None) -> None:
        """Delete a single user's records and drop their RAM-only session.

        Other users' data is never touched (logout-wipe isolation). The
        pinned server is reset only when the *last* certificate is gone.
        """
        if not username:
            return
        self.drop_session(username)
        self._failed_attempts.pop(username, None)
        self._enrollment_profiles.pop(username, None)
        self.registry.delete_user(username)
        self._reset_pin_if_last_cert()
        logger.info("User '%s' wiped.", username)

    def wipe_ephemeral(self) -> None:
        """Wipe the whole install (all users, RAM sessions, pin).

        Used by legacy paths and tests; logout-wipe normally only touches the
        logged-in user via wipe_user().
        """
        self._sessions.clear()
        self._enrollment_profiles.clear()
        self._failed_attempts.clear()
        self._deactivate()
        for account in self.registry.list_accounts():
            self.registry.delete_user(account.username)
        self._reset_pin_if_last_cert()
        logger.info("Ephemeral storage wiped.")


auth_manager = AuthManager()
