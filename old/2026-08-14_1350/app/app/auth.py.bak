#!/usr/bin/env python3
# auth.py from https://github.com/sgofferj/tak-webview-cesium
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
from datetime import UTC, datetime
from typing import Any

import httpx
from cryptography import x509
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .config import settings

logger = logging.getLogger("tak-webview.auth")


class AuthManager:
    def __init__(self) -> None:
        self.ephemeral_dir = settings.ephemeral_dir
        self.creds_file = os.path.join(self.ephemeral_dir, settings.ephemeral_creds)

        self.cert_file = os.path.join(self.ephemeral_dir, settings.ephemeral_cert)
        self.key_file = os.path.join(self.ephemeral_dir, settings.ephemeral_key)
        self.ca_file = os.path.join(self.ephemeral_dir, settings.ephemeral_ca)

        os.makedirs(self.ephemeral_dir, exist_ok=True)
        self.failed_attempts = 0
        # This will now store the master STORAGE_KEY instead of the cleartext password
        self._storage_key: bytes | None = None

    def _derive_fernet_key(self, password: str, salt: str) -> bytes:
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

    def _get_enrollment_secret(self, password: str, salt: str) -> str:
        """Generate a deterministic but strong secret for the TAK enrollment CSR."""
        combined = f"{password}:{salt}:enrollment"
        return hashlib.sha256(combined.encode("utf-8")).hexdigest()[:16]

    def validate_password_strength(self, password: str, username: str) -> bool:
        """
        Validate password strength.
        Minimum 8 characters, must not be 'atakatak', username, or empty.
        """
        if not password or len(password) < 8:
            return False
        if password.lower() in ["atakatak", username.lower()]:
            return False
        return True

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

            # 4. Save everything in our format
            self.wipe_ephemeral()

            # Derive storage key
            _, salt = self.hash_password(final_password)
            storage_key = self._derive_fernet_key(final_password, salt)

            # Encrypt private key
            key_bytes = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            f_box = Fernet(storage_key)
            encrypted_key_blob = f_box.encrypt(key_bytes)

            # Convert certificate to PEM
            cert_pem = certificate.public_bytes(serialization.Encoding.PEM)

            # Write files
            with open(self.key_file, "wb") as f:
                f.write(encrypted_key_blob)

            with open(self.cert_file, "wb") as f:
                f.write(cert_pem)

            if additional_certificates:
                with open(self.ca_file, "wb") as f:
                    for ca in additional_certificates:
                        f.write(ca.public_bytes(serialization.Encoding.PEM))
                        f.write(b"\n")

            self.save_credentials(username, final_password, server, salt=salt)
            logger.info("P12 upload for user '%s' successful", username)
            return username

        except Exception as e:
            logger.error("P12 import error: %s: %s", type(e).__name__, e)
            return None

    def save_credentials(
        self, username: str, password: str, server: str, salt: str | None = None
    ) -> None:
        """
        Save login hash and server address.
        Uses provided salt or generates new one.
        """
        pw_hash, salt = self.hash_password(password, salt)
        self._storage_key = self._derive_fernet_key(password, salt)

        data = {
            "username": username,
            "hash": pw_hash,
            "salt": salt,
            "server": server,
        }
        with open(self.creds_file, "w", encoding="utf-8") as f_out:
            json.dump(data, f_out)

    @property
    def enrolled_server(self) -> str | None:
        if not os.path.exists(self.creds_file):
            return None
        try:
            with open(self.creds_file, encoding="utf-8") as f_in:
                data = json.load(f_in)
            server = data.get("server")
            return str(server) if server is not None else None
        except (OSError, json.JSONDecodeError):
            return None

    def verify_credentials(self, username: str, password: str) -> bool:
        if not os.path.exists(self.creds_file):
            return False

        try:
            with open(self.creds_file, encoding="utf-8") as f_in:
                data = json.load(f_in)

            if data.get("username") != username:
                return False

            salt = data.get("salt")
            check_hash, _ = self.hash_password(password, salt)
            if secrets.compare_digest(check_hash, data.get("hash", "")):
                # Derive and cache the storage key in RAM only
                self._storage_key = self._derive_fernet_key(password, salt)
                return True
            return False
        except (OSError, json.JSONDecodeError) as e:
            logger.error("Failed to verify credentials: %s", e)
            return False

    def is_enrolled(self) -> bool:
        return all(
            os.path.exists(f) for f in [self.cert_file, self.key_file, self.creds_file]
        )

    def _ensure_pem_headers(self, cert_str: str, tag: str = "CERTIFICATE") -> bytes:
        cert_str = (cert_str or "").strip()
        if not cert_str:
            return b""

        header = f"-----BEGIN {tag}-----"
        footer = f"-----END {tag}-----"
        if not cert_str.startswith("-----BEGIN"):
            cert_str = f"{header}\n{cert_str}\n{footer}"
        return cert_str.encode("utf-8")

    def get_cert_info(self) -> dict[str, Any] | None:
        if not os.path.exists(self.cert_file):
            return None

        try:
            with open(self.cert_file, "rb") as f:
                cert_data = f.read()

            cert = x509.load_pem_x509_certificate(cert_data)
            cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
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
                "expiry": expiry.isoformat(),
                "status": status,
                "days_left": delta.days,
            }
        except Exception as e:
            logger.error("Failed to read cert info: %s", e)
            return None

    def get_private_key(self) -> bytes | None:
        """Decrypt the private key from disk into RAM."""
        if not os.path.exists(self.key_file):
            logger.error("Private key file missing on disk")
            return None
        if not self._storage_key:
            logger.error("Storage key not initialized in RAM (not logged in?)")
            return None

        try:
            with open(self.key_file, "rb") as f:
                encrypted_key = f.read()

            f_box = Fernet(self._storage_key)
            decrypted = f_box.decrypt(encrypted_key)
            return bytes(decrypted) if decrypted is not None else None
        except Exception as e:
            logger.error(
                "Failed to decrypt private key in RAM: %s: %s", type(e).__name__, e
            )
            return None

    async def enroll(self, server: str, username: str, password: str) -> bool:
        """Enroll the client with a TAK server."""
        # pylint: disable=too-many-locals,too-many-branches,too-many-statements
        self.wipe_ephemeral()
        uid = settings.tak_uid_final
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
                from lxml import etree

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
                f_box = Fernet(storage_key)
                encrypted_key_blob = f_box.encrypt(key_bytes)

                # Write files
                with open(self.key_file, "wb") as f:  # noqa: ASYNC101
                    f.write(encrypted_key_blob)

                with open(self.cert_file, "wb") as f:  # noqa: ASYNC101
                    f.write(client_cert_pem)

                if ca_certs:
                    with open(self.ca_file, "wb") as f:  # noqa: ASYNC101
                        for cert in ca_certs:
                            f.write(cert)
                            f.write(b"\n")

                self.save_credentials(username, password, server, salt=salt)
                logger.info("Enrollment successful")
                return True

        except Exception as e:
            logger.error("Enrollment error: %s", e)
            return False

    def wipe_ephemeral(self) -> None:
        self.failed_attempts = 0
        self._storage_key = None
        for f in [self.cert_file, self.key_file, self.ca_file, self.creds_file]:
            if os.path.exists(f):
                os.remove(f)
        logger.info("Ephemeral storage wiped.")


auth_manager = AuthManager()
