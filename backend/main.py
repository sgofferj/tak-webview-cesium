import asyncio
import datetime
import json
import logging
import os
import re
import ssl
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from anyio import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import HTTPConnection
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from lxml import etree
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# --- CONFIGURATION ---


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

    # Paths
    iconsets_dir: str = "/iconsets"
    user_iconsets_dir: str = "/user_iconsets"

    def __init__(self, **values: Any):
        super().__init__(**values)
        if not self.tak_uid:
            self.tak_uid = f"CesiumViewer-{self.tak_callsign}"


settings = Settings()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tak-webview")


# --- ICONSET MANAGEMENT ---

iconsets_cache: dict[str, dict[str, Any]] = {}


def load_iconsets(directory: str, mount_prefix: str) -> None:
    """Scans the given directory for iconset.xml files and builds a UID mapping."""
    if not os.path.exists(directory):
        logger.info("Directory %s not found. Skipping.", directory)
        return

    logger.info("Scanning for iconsets in %s...", directory)
    for root, _, files in os.walk(directory):
        if "iconset.xml" in files:
            xml_path = os.path.join(root, "iconset.xml")
            try:
                tree = etree.parse(xml_path)
                iconset_el = tree.getroot()
                uid = iconset_el.get("uid")
                name = iconset_el.get("name")
                if uid:
                    rel_path = os.path.relpath(root, directory)
                    if rel_path == ".":
                        url_path = mount_prefix
                    else:
                        url_path = f"{mount_prefix}/{rel_path}"

                    iconsets_cache[uid] = {
                        "name": name or "Unknown",
                        "url_path": url_path,
                        "icons": {},
                        "type_map": {},
                    }
                    for icon in iconset_el.findall("icon"):
                        icon_name = icon.get("name")
                        type2525b = icon.get("type2525b")
                        if icon_name:
                            iconsets_cache[uid]["icons"][icon_name] = icon_name
                            if type2525b:
                                iconsets_cache[uid]["type_map"][type2525b] = icon_name
                    logger.info("Loaded iconset: %s (UID: %s) from %s", name, uid, root)
            except Exception as exc:
                logger.error("Error parsing iconset at %s: %s", xml_path, exc)


# --- WEBSOCKET MANAGEMENT ---


def get_client_ip(connection: HTTPConnection) -> str:
    """Extracts the real client IP considering trusted proxies."""
    client_host = connection.client.host if connection.client else "unknown"
    if client_host in settings.trusted_proxies or any(
        client_host.startswith(tp) for tp in settings.trusted_proxies if "/" in tp
    ):
        forwarded_for = connection.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
    return client_host


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info("Client connected: %s", get_client_ip(websocket))

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("Client disconnected: %s", get_client_ip(websocket))

    async def broadcast(self, message: str) -> None:
        if not self.active_connections:
            return
        await asyncio.gather(
            *(self._send_safe(conn, message) for conn in self.active_connections)
        )

    async def _send_safe(self, websocket: WebSocket, message: str) -> None:
        try:
            await websocket.send_text(message)
        except Exception:
            # Connection likely closed, will be handled by disconnect
            pass


manager = ConnectionManager()


# --- TAK CLIENT ---


class TAKClient:
    def __init__(self, config: Settings, broadcast_callback: Any):
        self.config = config
        self.broadcast = broadcast_callback
        self.running = False

    def create_heartbeat(self) -> bytes:
        now = datetime.datetime.now(datetime.UTC)
        stale = now + datetime.timedelta(seconds=60)
        now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

        return (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<event version="2.0" uid="{self.config.tak_uid}" '
            f'type="{self.config.tak_type}" '
            f'time="{now_str}" start="{now_str}" stale="{stale_str}" how="h-g-i-g-o">'
            f'<point lat="0.0" lon="0.0" hae="0.0" ce="9999999" le="9999999"/>'
            f'<detail><contact callsign="{self.config.tak_callsign}"/></detail>'
            f"</event>"
        ).encode()

    def parse_cot(self, xml_data: bytes) -> dict[str, Any] | None:
        try:
            if b"<event" not in xml_data:
                return None

            root = etree.fromstring(xml_data.strip())
            uid = root.get("uid")
            ctype = root.get("type")
            if not uid or not ctype:
                return None

            point = root.find("point")
            if point is None:
                return None

            data = {
                "uid": uid,
                "type": ctype,
                "callsign": uid,
                "lat": float(point.get("lat", 0)),
                "lon": float(point.get("lon", 0)),
                "alt": float(point.get("hae", 0)),
                "stale": root.get("stale"),
                "remarks": "",
            }

            # Detail parsing
            detail = root.find("detail")
            if detail is not None:
                contact = detail.find("contact")
                if contact is not None:
                    data["callsign"] = contact.get("callsign", uid)
                    data["squawk"] = contact.get("track")

                track = detail.find("track")
                if track is not None:
                    data["course"] = float(track.get("course", 0))
                    data["speed"] = float(track.get("speed", 0))

                remarks_el = detail.find("remarks")
                if remarks_el is not None:
                    data["remarks"] = remarks_el.text or ""

                link = detail.find("link")
                if link is not None:
                    data["link_url"] = link.get("url")

                emergency = detail.find("emergency")
                if emergency is not None:
                    if emergency.get("cancel") == "true":
                        data["emergency"] = {"status": "cancelled"}
                    else:
                        data["emergency"] = {
                            "status": "active",
                            "type": emergency.get("type", "Emergency"),
                            "value": emergency.text or "",
                        }
                        if emergency.text:
                            data["callsign"] = emergency.text

                # Squawk fallback
                remarks = data.get("remarks")
                if not data.get("squawk") and isinstance(remarks, str) and remarks:
                    re_match = re.search(r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.I)
                    if re_match:
                        data["squawk"] = re_match.group(1)

            return data
        except Exception as e:
            if self.config.log_cots:
                logger.debug("CoT Parse Error: %s", e)
            return None

    async def run(self) -> None:
        self.running = True
        ssl_ctx = self._setup_ssl()
        if not ssl_ctx:
            return

        while self.running:
            try:
                logger.info(
                    "Connecting to TAK Server at %s:%s...",
                    self.config.tak_host,
                    self.config.tak_port,
                )
                reader, writer = await asyncio.open_connection(
                    self.config.tak_host, self.config.tak_port, ssl=ssl_ctx
                )
                try:
                    logger.info("Connected to TAK Server.")
                    await asyncio.gather(
                        self._send_heartbeats(writer), self._process_stream(reader)
                    )
                finally:
                    writer.close()
                    await writer.wait_closed()
            except Exception as e:
                logger.error("TAK Connection error: %s. Retrying in 5s...", e)
                await asyncio.sleep(5)

    def _setup_ssl(self) -> ssl.SSLContext | None:
        if not (self.config.tak_tls_client_cert and self.config.tak_tls_client_key):
            logger.error("Missing TLS certificates. Cannot start TAK Client.")
            return None

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        if self.config.tak_tls_ca_cert and os.path.exists(self.config.tak_tls_ca_cert):
            ctx.load_verify_locations(cafile=self.config.tak_tls_ca_cert)
        else:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

        try:
            ctx.load_cert_chain(
                certfile=self.config.tak_tls_client_cert,
                keyfile=self.config.tak_tls_client_key,
            )
            return ctx
        except Exception as e:
            logger.error("Failed to load certificates: %s", e)
            return None

    async def _send_heartbeats(self, writer: asyncio.StreamWriter) -> None:
        while self.running:
            try:
                writer.write(self.create_heartbeat())
                await writer.drain()
                await asyncio.sleep(30)
            except Exception:
                break

    async def _process_stream(self, reader: asyncio.StreamReader) -> None:
        buffer = b""
        while self.running:
            try:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buffer += chunk
                while b"</event>" in buffer:
                    idx = buffer.find(b"</event>") + 8
                    msg = buffer[:idx]
                    buffer = buffer[idx:]
                    parsed = self.parse_cot(msg)
                    if parsed:
                        await self.broadcast(json.dumps(parsed))
            except Exception:
                break


# --- API & LIFESPAN ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
static_dir = os.path.join(BASE_DIR, "static")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    load_iconsets(settings.iconsets_dir, "/iconsets")
    load_iconsets(settings.user_iconsets_dir, "/user_iconsets")

    client = TAKClient(settings, manager.broadcast)
    tak_task = asyncio.create_task(client.run())

    yield

    # Shutdown
    client.running = False
    tak_task.cancel()
    try:
        await tak_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/config")
async def get_config() -> dict[str, Any]:
    return {
        "app_title": settings.app_title,
        "center_alert": settings.center_alert,
        "iconsets": iconsets_cache,
        "terrain_url": settings.terrain_url,
        "terrain_exaggeration": settings.terrain_exaggeration,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
        manager.disconnect(websocket)


# Static File Mounting
if os.path.exists(static_dir):
    for sub in ["assets", "cesium", "locales"]:
        d = os.path.join(static_dir, sub)
        if os.path.exists(d):
            app.mount(f"/{sub}", StaticFiles(directory=d), name=sub)

if os.path.exists(settings.iconsets_dir):
    app.mount(
        "/iconsets", StaticFiles(directory=settings.iconsets_dir), name="iconsets"
    )

if os.path.exists(settings.user_iconsets_dir):
    app.mount(
        "/user_iconsets",
        StaticFiles(directory=settings.user_iconsets_dir),
        name="user_iconsets",
    )


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str) -> Any:
    if await Path(static_dir).exists():
        file_path = os.path.join(static_dir, full_path)
        if await Path(file_path).is_file():
            return FileResponse(file_path)

    if full_path.startswith(("ws", "api", "config", "iconsets")):
        return {"error": "Not Found"}

    index_path = os.path.join(static_dir, "index.html")
    if await Path(index_path).exists():
        return FileResponse(index_path)

    return {"message": "TAK Cesium Backend Running"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port)
