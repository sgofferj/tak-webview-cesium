#!/usr/bin/env python3
# config.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import hashlib
import json
import secrets
from typing import Any, ClassVar

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_title: str = "TAK Cesium Map"
    tak_host: str = "localhost"
    tak_port: int = 8089
    tak_callsign: str = "CesiumViewer"
    tak_type: str = "a-f-G-U-C-I"
    tak_uid: str | None = None

    # New fields for messaging configuration
    tak_callsign_input: str = ""  # overridden callsign from UI
    tak_color: str = ""  # color chosen by user
    tak_group_color: str = "Cyan"  # color for SA/__group
    tak_role: str = ""  # role chosen by user

    # Marti REST API (TLS) port - channel/group subscription endpoints
    tak_api_port: int = 8443

    # Enrollment
    tak_enroll_port: int = 8446
    force_server: str | None = None
    _ephemeral_dir: str = "/app/certs/ephemeral"
    ephemeral_cert: str = "cert.pem"
    ephemeral_key: str = "cert.key"
    ephemeral_ca: str = "ca.pem"
    ephemeral_creds: str = "creds.json"

    # Security
    secret_key: str = Field(default_factory=lambda: secrets.token_urlsafe(32))

    # App Behavior
    log_cots: bool = False
    center_alert: bool = False
    port: int = 8000

    # Traffic Optimization
    ws_throttle: float = 0.5  # Max 2 updates per second per UID
    use_msgpack: bool = True
    tak_staff_comments: str = ""

    # Use str | list[str] to satisfy Ruff/UP007 and prevent Pydantic JSON forcing
    trusted_proxies: str | list[str] = Field(default_factory=lambda: ["127.0.0.1"])

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def parse_trusted_proxies(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                try:
                    parsed = json.loads(v)
                    if isinstance(parsed, list):
                        return [str(x).strip() for x in parsed if str(x).strip()]
                except (ValueError, TypeError):
                    pass
            return [x.strip() for x in v.split(",") if x.strip()]
        if isinstance(v, list | tuple):
            return [str(x).strip() for x in v if str(x).strip()]
        return ["127.0.0.1"]

    # ------------------------------------------------------------------
    #  Valid colour list (as specified by the TAK UI)
    # ------------------------------------------------------------------
    VALID_COLOURS: ClassVar[frozenset[str]] = frozenset(
        {
            "White",
            "Yellow",
            "Orange",
            "Magenta",
            "Red",
            "Maroon",
            "Cyan",
            "Dark Cyan",
            "Blue",
            "Dark Blue",
            "Green",
            "Dark Green",
            "Brown",
            "Purple",
        }
    )

    # ------------------------------------------------------------------
    #  Valid role list
    # ------------------------------------------------------------------
    VALID_ROLES: ClassVar[frozenset[str]] = frozenset(
        {
            "Team Member",
            "Team Lead",
            "HQ",
            "Sniper",
            "Medic",
            "Forward Observer",
            "RTO",
            "K9",
            "Pilot",
        }
    )

    # ------------------------------------------------------------------
    #  Colour validator – only allow the whitelisted colours
    # ------------------------------------------------------------------
    @field_validator("tak_color", mode="before")
    @classmethod
    def validate_tak_color(cls, v: Any) -> str:
        if isinstance(v, str) and v.strip() == "":
            return v
        value = str(v)
        if value not in cls.VALID_COLOURS:  # cls accesses the ClassVar
            raise ValueError(
                f"Invalid colour {value!r}; must be one of {cls.VALID_COLOURS}"
            )
        return value

    # ------------------------------------------------------------------
    #  Role validator – only allow the whitelisted roles
    # ------------------------------------------------------------------
    @field_validator("tak_role", mode="before")
    @classmethod
    def validate_tak_role(cls, v: Any) -> str:
        if isinstance(v, str) and v.strip() == "":
            return v
        value = str(v)
        if value not in cls.VALID_ROLES:  # cls accesses the ClassVar
            raise ValueError(
                f"Invalid role {value!r}; must be one of {cls.VALID_ROLES}"
            )
        return value

    # UI / Map
    initial_lat: float = 60.1699
    initial_lon: float = 24.9384
    terrain_url: str | None = None
    terrain_exaggeration: float = 1.0
    cesium_ion_token: str | None = None
    logo: str | None = None
    logo_position: str = "bottom_right"
    goto_buttons: str = ""

    # Paths
    _iconsets_dir: str = "/iconsets"
    _overlays_dir: str = "/app/overlays"
    _user_iconsets_dir: str = "/app/user_iconsets"
    layers_config_file: str = "customlayers.json"

    @property
    def ephemeral_dir(self) -> str:
        return self._ephemeral_dir

    @property
    def iconsets_dir(self) -> str:
        return self._iconsets_dir

    @property
    def overlays_dir(self) -> str:
        return self._overlays_dir

    @property
    def user_iconsets_dir(self) -> str:
        return self._user_iconsets_dir

    @property
    def tak_uid_final(self) -> str:
        if self.tak_uid:
            return self.tak_uid
        return f"CesiumViewer-{self.tak_callsign}"

    def uid_for_username(self, username: str) -> str:
        """Derive a stable, distinct per-user UID from the cert CN (username).

        The username is hashed so it is never transmitted in cleartext as the
        UID. The hash is deterministic, so the same user always gets the same
        UID (and it can be verified internally by re-hashing the username).
        """
        if self.tak_uid:
            return self.tak_uid
        digest = hashlib.sha256((username or "").strip().encode("utf-8")).hexdigest()
        return f"CesiumViewer-{digest[:16]}"


settings = Settings()
