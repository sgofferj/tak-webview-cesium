from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # TAK Server Connection
    tak_host: str = "localhost"
    tak_port: int = 8089
    tak_tls_client_cert: str = "certs/cert.pem"
    tak_tls_client_key: str = "certs/cert.key"
    tak_tls_ca_cert: str | None = None

    # Identity
    tak_callsign: str = "CesiumViewer"
    tak_type: str = "a-f-G-U-C-I"
    tak_uid: str | None = None

    # App Behavior
    app_title: str = "TAK Cesium Map"
    log_cots: bool = False
    center_alert: bool = False
    port: int = 8000
    # Use Any to prevent pydantic-settings from auto-parsing JSON for list types
    trusted_proxies: Any = Field(default_factory=list)
    
    # Traffic Optimization
    ws_throttle: float = 0.5  # Max 2 updates per second per UID
    use_msgpack: bool = True

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def parse_trusted_proxies(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            # If it's a JSON-like string, try to parse it
            if v.strip().startswith("[") and v.strip().endswith("]"):
                import json
                try:
                    res = json.loads(v)
                    if isinstance(res, list):
                        return [str(item).strip() for item in res]
                except json.JSONDecodeError:
                    pass
            # Fallback to comma-separated
            return [item.strip() for item in v.split(",") if item.strip()]
        if isinstance(v, list):
            return [str(item).strip() for item in v]
        return v or []

    # UI / Map
    terrain_url: str | None = None
    terrain_exaggeration: float = 1.0
    cesium_ion_token: str | None = None
    logo: str | None = None
    logo_position: str = "bottom_right"

    # Paths
    iconsets_dir: str = "/iconsets"
    user_iconsets_dir: str = "/user_iconsets"
    layers_config_file: str = "customlayers.json"

    def __init__(self, **values: Any):
        super().__init__(**values)
        if not self.tak_uid:
            self.tak_uid = f"CesiumViewer-{self.tak_callsign}"

settings = Settings()
