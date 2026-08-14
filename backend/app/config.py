#!/usr/bin/env python3
# config.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

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
    tak_role: str = ""  # role chosen by user

    # Enrollment
    tak_enroll_port: int = 8446
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
            return [x.strip() for x in v.split(",") if x.strip()]
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
        if v not in cls.VALID_COLOURS:  # cls accesses the ClassVar
            raise ValueError(
                f"Invalid colour {v!r}; must be one of {cls.VALID_COLOURS}"
            )
        return v

    # ------------------------------------------------------------------
    #  Role validator – only allow the whitelisted roles
    # ------------------------------------------------------------------
    @field_validator("tak_role", mode="before")
    @classmethod
    def validate_tak_role(cls, v: Any) -> str:
        if isinstance(v, str) and v.strip() == "":
            return v
        if v not in cls.VALID_ROLES:  # cls accesses the ClassVar
            raise ValueError(f"Invalid role {v!r}; must be one of {cls.VALID_ROLES}")
        return v

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


settings = Settings()
