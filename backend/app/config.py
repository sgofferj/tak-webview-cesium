#!/usr/bin/env python3
# config.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_title: str = "TAK Cesium Map"
    tak_host: str = "localhost"
    tak_port: int = 8089
    tak_tls_client_cert: str = "certs/cert.pem"
    tak_tls_client_key: str = "certs/cert.key"
    tak_tls_ca_cert: str | None = None
    tak_callsign: str = "CesiumViewer"
    tak_uid: str | None = None
    iconsets_dir: str = "/iconsets"
    user_iconsets_dir: str = "/user_iconsets"
    layers_config_file: str = "customlayers.json"
    terrain_url: str | None = None
    terrain_exaggeration: float = 1.0
    log_cots: bool = False
    center_alert: bool = False
    # Use str | list[str] to satisfy Ruff/UP007 and prevent Pydantic JSON forcing
    trusted_proxies: str | list[str] = Field(
        default_factory=lambda: ["127.0.0.1"]
    )
    port: int = 8000
    cesium_ion_token: str | None = None
    logo: str | None = None
    logo_position: str = "bottom_right"

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def split_proxies(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            return [x.strip() for x in v.split(",") if x.strip()]
        if isinstance(v, list):
            return v
        return ["127.0.0.1"]

    @property
    def tak_uid_final(self) -> str:
        if self.tak_uid:
            return self.tak_uid
        return f"CesiumViewer-{self.tak_callsign}"


settings = Settings()
