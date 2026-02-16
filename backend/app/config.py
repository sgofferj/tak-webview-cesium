from typing import Any

from pydantic import Field
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
    trusted_proxies: list[str] = Field(default_factory=list)

    # UI / Map
    terrain_url: str | None = None
    terrain_exaggeration: float = 1.0
    imagery_layers: list[dict[str, Any]] = Field(default_factory=lambda: [
        {
            "name": "Finnish Background",
            "url": "https://tiles.kartat.kapsi.fi/taustakartta?",
            "layers": "taustakartta",
            "rectangle": [19.0, 59.0, 32.0, 71.0],
            "icon": "https://tiles.kartat.kapsi.fi/taustakartta?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=taustakartta&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
        },
        {
            "name": "Finnish Topo",
            "url": "https://tiles.kartat.kapsi.fi/peruskartta?",
            "layers": "peruskartta",
            "rectangle": [19.0, 59.0, 32.0, 71.0],
            "icon": "https://tiles.kartat.kapsi.fi/peruskartta?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=peruskartta&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
        },
        {
            "name": "Finnish Aerial",
            "url": "https://tiles.kartat.kapsi.fi/ortokuva?",
            "layers": "ortokuva",
            "rectangle": [19.0, 59.0, 32.0, 71.0],
            "icon": "https://tiles.kartat.kapsi.fi/ortokuva?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=ortokuva&WIDTH=100&HEIGHT=100&FORMAT=image/png&SRS=EPSG:3857&BBOX=2770000,8420000,2780000,8430000",
        }
    ])

    # Paths
    iconsets_dir: str = "/iconsets"
    user_iconsets_dir: str = "/user_iconsets"

    def __init__(self, **values: Any):
        super().__init__(**values)
        if not self.tak_uid:
            self.tak_uid = f"CesiumViewer-{self.tak_callsign}"

settings = Settings()
