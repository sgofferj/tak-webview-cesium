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
from datetime import datetime, timezone
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
        self.cert_password: str | None = None

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

    def save_credentials(self, username: str, password: str, cert_password: str, server: str) -> None:
        """Save login hash, ENCRYPTED cert decryption password and server address."""
        pw_hash, salt = self.hash_password(password)

        # Encrypt the cert_password using the login password
        key = self._derive_fernet_key(password, salt)
        f = Fernet(key)
        encrypted_cert_pw = f.encrypt(cert_password.encode("utf-8")).decode("utf-8")

        data = {
            "username": username,
            "hash": pw_hash,
            "salt": salt,
            "encrypted_cert_pw": encrypted_cert_pw,
            "server": server,
        }
        with open(self.creds_file, "w", encoding="utf-8") as f_out:
            json.dump(data, f_out)

    @property
    def enrolled_server(self) -> str | None:
        if not os.path.exists(self.creds_file):
            return None
        try:
            with open(self.creds_file, "r", encoding="utf-8") as f_in:
                data = json.load(f_in)
            return data.get("server")
        except (OSError, json.JSONDecodeError):
            return None

    def verify_credentials(self, username: str, password: str) -> bool:
        if not os.path.exists(self.creds_file):
            return False

        try:
            with open(self.creds_file, "r", encoding="utf-8") as f_in:
                data = json.load(f_in)

            if data.get("username") != username:
                return False

            salt = data.get("salt")
            check_hash, _ = self.hash_password(password, salt)
            if secrets.compare_digest(check_hash, data.get("hash", "")):
                # Decrypt the cert_password into memory
                try:
                    key = self._derive_fernet_key(password, salt)
                    fernet = Fernet(key)
                    self.cert_password = fernet.decrypt(
                        data.get("encrypted_cert_pw", "").encode("utf-8")
                    ).decode("utf-8")
                    return True
                except Exception as e:
                    logger.error(f"Failed to decrypt stored cert password: {e}")
                    return False
            return False
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to verify credentials: {e}")
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

            now = datetime.now(timezone.utc)
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
        except (OSError, ValueError, Exception) as e:
            logger.error(f"Failed to read cert info: {e}")
            return None

    async def enroll(
        self, server: str, username: str, password: str, cert_password: str
    ) -> bool:
        self.wipe_ephemeral()
        uid = settings.tak_uid_final
        base_url = f"https://{server}:{settings.tak_enroll_port}/Marti/api/tls"

        try:
            # 1. Generate Key Pair (Needed for CSR)
            temp_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

            async with httpx.AsyncClient(verify=False) as client:
                # 2. Get Config
                auth = httpx.BasicAuth(username, password)
                config_resp = await client.get(f"{base_url}/config", auth=auth)

                if config_resp.status_code != 200:
                    logger.error(f"Config request failed: {config_resp.status_code}")
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

                # ATAK uses the username as CN
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

                # ATAK strips the banners!
                csr_body = (
                    csr_pem.decode("utf-8")
                    .replace("-----BEGIN CERTIFICATE REQUEST-----", "")
                    .replace("-----END CERTIFICATE REQUEST-----", "")
                    .strip()
                    .encode("utf-8")
                )

                # 5. Sign Client
                sign_url = f"{base_url}/signClient/v2?clientUid={uid}&version=4.10.0"
                headers = {
                    "Accept": "application/xml",
                    "Content-Type": "application/octet-stream",
                }

                sign_resp = await client.post(
                    sign_url, auth=auth, content=csr_body, headers=headers
                )

                if sign_resp.status_code != 200:
                    logger.error(
                        f"Signing failed: {sign_resp.status_code} - {sign_resp.text}"
                    )
                    return False

                # 6. Parse XML Response
                root = etree.fromstring(sign_resp.content)
                client_cert_pem = None
                private_key_pem = None
                ca_certs = []

                for child in root:
                    tag_name = child.tag
                    if "}" in tag_name:
                        tag_name = tag_name.split("}")[1]

                    logger.info(f"Enrollment response tag: {tag_name}")

                    if tag_name == "signedCert":
                        client_cert_pem = self._ensure_pem_headers(child.text)
                    elif tag_name == "privateKey":
                        # The TAK server provides the private key ENCRYPTED with cert_password
                        private_key_pem = self._ensure_pem_headers(
                            child.text, "ENCRYPTED PRIVATE KEY"
                        )
                    else:
                        ca_certs.append(self._ensure_pem_headers(child.text))

                # Use temp_key if server didn't provide one
                if not private_key_pem:
                    logger.info("Server did not provide private key, using local temp")
                    private_key_pem = temp_key.private_bytes(
                        encoding=serialization.Encoding.PEM,
                        format=serialization.PrivateFormat.PKCS8,
                        encryption_algorithm=serialization.BestAvailableEncryption(
                            cert_password.encode("utf-8")
                        ),
                    )

                if not client_cert_pem:
                    logger.error("No signedCert found in response")
                    return False

                # Write files
                with open(self.key_file, "wb") as f:
                    f.write(private_key_pem)

                with open(self.cert_file, "wb") as f:
                    f.write(client_cert_pem)

                if ca_certs:
                    with open(self.ca_file, "wb") as f:
                        for cert in ca_certs:
                            f.write(cert)
                            f.write(b"\n")

                self.save_credentials(username, password, cert_password, server)
                self.cert_password = cert_password  # Keep in memory for immediate use
                logger.info("Enrollment successful")
                return True

        except (httpx.RequestError, OSError, ValueError, Exception) as e:
            logger.error(f"Enrollment error: {e}")
            return False

    def wipe_ephemeral(self) -> None:
        self.authenticated = False
        self.failed_attempts = 0
        self.cert_password = None
        for f in [self.cert_file, self.key_file, self.ca_file, self.creds_file]:
            if os.path.exists(f):
                os.remove(f)
        logger.info("Ephemeral storage wiped.")


auth_manager = AuthManager()
