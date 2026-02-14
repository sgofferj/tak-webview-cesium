import asyncio
import datetime
import json
import logging
import os
import re
import ssl
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import HTTPConnection
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from lxml import etree

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# TAK Configuration from environment
TAK_HOST: str = os.getenv("TAK_HOST", "localhost")
TAK_PORT: int = int(os.getenv("TAK_PORT", "8089"))
TAK_TLS_CLIENT_CERT: str | None = os.getenv("TAK_TLS_CLIENT_CERT", "certs/cert.pem")
TAK_TLS_CLIENT_KEY: str | None = os.getenv("TAK_TLS_CLIENT_KEY", "certs/cert.key")
TAK_TLS_CA_CERT: str | None = os.getenv("TAK_TLS_CA_CERT")

# Identity configuration
TAK_CALLSIGN: str = os.getenv("TAK_CALLSIGN", "CesiumViewer")
TAK_TYPE: str = os.getenv("TAK_TYPE", "a-f-G-U-C-I")
TAK_UID: str = os.getenv("TAK_UID", f"CesiumViewer-{TAK_CALLSIGN}")
LOG_COTS: bool = os.getenv("LOG_COTS", "false").lower() == "true"

# Iconset configuration
ICONSETS_DIR: str = os.getenv("ICONSETS_DIR", "/iconsets")
USER_ICONSETS_DIR: str = os.getenv("USER_ICONSETS_DIR", "/user_iconsets")
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
                    # Map UID to the URL path containing the icons
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
                    # Map icon names and type2525b
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


# Proxy and Alert Configuration
TRUSTED_PROXIES: list[str] = [
    p.strip() for p in os.getenv("TRUSTED_PROXIES", "").split(",") if p.strip()
]
CENTER_ALERT: bool = os.getenv("CENTER_ALERT", "false").lower() == "true"


app = FastAPI()

# Enable CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_client_ip(connection: HTTPConnection) -> str:
    """Extracts the real client IP considering trusted proxies."""
    client_host = connection.client.host if connection.client else "unknown"
    if client_host in TRUSTED_PROXIES or any(
        client_host.startswith(tp) for tp in TRUSTED_PROXIES if "/" in tp
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
        client_ip = get_client_ip(websocket)
        logger.info("Client connected: %s", client_ip)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            client_ip = get_client_ip(websocket)
            logger.info("Client disconnected: %s", client_ip)

    async def broadcast(self, message: str) -> None:
        for connection in list(self.active_connections):
            try:
                await connection.send_text(message)
            except Exception as exc:  # pylint: disable=broad-exception-caught
                logger.debug("Failed to send message to a client: %s", exc)


manager = ConnectionManager()

# Debug: check for static directory
static_dir = os.path.join(os.path.dirname(__file__), "static")
logger.info("Checking for static directory at: %s", os.path.abspath(static_dir))
if os.path.exists(static_dir):
    logger.info("Static directory found. Contents: %s", os.listdir(static_dir))
else:
    logger.warning("Static directory NOT FOUND.")


@app.get("/config")


async def get_config() -> dict[str, Any]:


    """Provides dynamic configuration to the frontend."""


    return {


        "center_alert": CENTER_ALERT,


        "iconsets": iconsets_cache,


        "terrain_url": os.getenv("TERRAIN_URL")


    }





def create_heartbeat() -> bytes:
    """Creates a standard TAK 'Hello' heartbeat CoT message."""
    now = datetime.datetime.now(datetime.UTC)
    stale = now + datetime.timedelta(seconds=60)

    now_str = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    stale_str = stale.strftime("%Y-%m-%dT%H:%M:%SZ")

    cot = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<event version="2.0" uid="{TAK_UID}" type="{TAK_TYPE}" '
        f'time="{now_str}" start="{now_str}" stale="{stale_str}" how="h-g-i-g-o">'
        f'<point lat="0.0" lon="0.0" hae="0.0" ce="9999999" le="9999999"/>'
        f'<detail><contact callsign="{TAK_CALLSIGN}"/></detail>'
        f"</event>"
    ).encode()
    return cot


def extract_point_data(root_el: etree._Element) -> dict[str, float]:
    """Extracts lat, lon, hae from the point element."""
    point = root_el.find("point")
    data = {"lat": 0.0, "lon": 0.0, "alt": 0.0}
    if point is not None:
        lat_attr = point.get("lat")
        lon_attr = point.get("lon")
        hae_attr = point.get("hae")
        if lat_attr and lon_attr:
            data["lat"] = float(lat_attr)
            data["lon"] = float(lon_attr)
            data["alt"] = float(hae_attr) if hae_attr else 0.0
    return data


def parse_cot(xml_data: bytes) -> dict[str, Any] | None:
    """Parses CoT XML data into a dictionary."""
    try:
        if b"<event" not in xml_data:
            return None

        root_el = etree.fromstring(xml_data.strip())
        uid = root_el.get("uid")
        ctype = root_el.get("type")
        if not uid or not ctype:
            return None

        callsign = uid
        contact = root_el.find("detail/contact")
        squawk = None
        if contact is not None:
            callsign_attr = contact.get("callsign")
            if callsign_attr:
                callsign = callsign_attr
            squawk = contact.get(
                "track"
            )  # Squawk is often in contact/track attribute in some ADSB feeders

        # Alternative location for squawk
        adsb_el = root_el.find("detail/precisionlocation")
        if adsb_el is not None and not squawk:
            squawk = adsb_el.get("altsource")  # Some feeders put it here

        # Standard track information
        course = None
        speed = None
        track_el = root_el.find("detail/track")
        if track_el is not None:
            course_attr = track_el.get("course")
            speed_attr = track_el.get("speed")
            if course_attr:
                course = float(course_attr)
            if speed_attr:
                speed = float(speed_attr)

        point_data = extract_point_data(root_el)

        color_argb = None
        color_el = root_el.find("detail/color")
        if color_el is not None:
            color_argb = color_el.get("argb")

        usericon_path = None
        usericon_el = root_el.find(".//usericon")
        if usericon_el is not None:
            usericon_path = usericon_el.get("iconsetpath")

        remarks = ""
        remarks_el = root_el.find("detail/remarks")
        if remarks_el is not None:
            remarks = remarks_el.text or ""

        # Extract squawk from remarks if not found in attributes
        if not squawk and remarks:
            match = re.search(r"Squawk:\s*([0-7]{4}|unknown)", remarks, re.IGNORECASE)
            if match:
                squawk = match.group(1)

        link_url = None
        link_el = root_el.find("detail/link")
        if link_el is not None:
            link_url = link_el.get("url")

        emergency = None
        emergency_el = root_el.find("detail/emergency")
        if emergency_el is not None:
            cancel_attr = emergency_el.get("cancel")
            if cancel_attr == "true":
                emergency = {"status": "cancelled"}
            else:
                emergency = {
                    "status": "active",
                    "type": emergency_el.get("type", "Emergency"),
                    "value": emergency_el.text or "",
                }
                if emergency_el.text:
                    callsign = emergency_el.text

        return {
            "uid": uid,
            "type": ctype,
            "callsign": callsign,
            "lat": point_data["lat"],
            "lon": point_data["lon"],
            "alt": point_data["alt"],
            "color": color_argb,
            "iconsetpath": usericon_path,
            "remarks": remarks,
            "link_url": link_url,
            "emergency": emergency,
            "course": course,
            "speed": speed,
            "squawk": squawk,
        }

    except etree.XMLSyntaxError:
        return None
    except (ValueError, TypeError) as exc:
        logger.error("Error parsing CoT values: %s", exc)
        return None


async def send_heartbeats(writer: asyncio.StreamWriter) -> None:
    """Periodically sends heartbeats to the TAK server."""
    try:
        while True:
            heartbeat = create_heartbeat()
            writer.write(heartbeat)
            await writer.drain()
            logger.debug("Sent heartbeat to TAK Server")
            await asyncio.sleep(30)
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.warning("Heartbeat task stopped: %s", exc)


async def process_tak_stream(reader: asyncio.StreamReader) -> None:
    """Processes the incoming stream from TAK server."""
    buffer = b""
    while True:
        try:
            chunk = await reader.read(4096)
            if not chunk:
                logger.warning("TAK Server closed connection.")
                break

            buffer += chunk
            while b"</event>" in buffer:
                split_index = buffer.find(b"</event>") + 8
                msg = buffer[:split_index]
                buffer = buffer[split_index:]

                if LOG_COTS:
                    logger.info(
                        "Received CoT: %s", msg.decode("utf-8", errors="replace")
                    )

                parsed = parse_cot(msg)
                if parsed:
                    await manager.broadcast(json.dumps(parsed))

        except asyncio.IncompleteReadError:
            break


async def tak_client() -> None:
    """Connects to TAK Server via TCP/TLS and streams data."""
    if not (TAK_TLS_CLIENT_CERT and TAK_TLS_CLIENT_KEY):
        logger.error("Missing TLS certificates. Cannot start TAK Client.")
        return

    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    if TAK_TLS_CA_CERT and os.path.exists(TAK_TLS_CA_CERT):
        ssl_ctx.load_verify_locations(cafile=TAK_TLS_CA_CERT)
    else:
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        ssl_ctx.load_cert_chain(
            certfile=TAK_TLS_CLIENT_CERT, keyfile=TAK_TLS_CLIENT_KEY
        )
    except OSError as exc:
        logger.error("Failed to load client certificate: %s", exc)
        return

    logger.info("Connecting to TAK Server at %s:%s...", TAK_HOST, TAK_PORT)

    while True:
        try:
            reader, writer = await asyncio.open_connection(
                TAK_HOST, TAK_PORT, ssl=ssl_ctx
            )
            try:
                logger.info("Connected to TAK Server via TLS.")
                heartbeat_task = asyncio.create_task(send_heartbeats(writer))
                await process_tak_stream(reader)
                heartbeat_task.cancel()
            finally:
                writer.close()
                await writer.wait_closed()
        except (ConnectionRefusedError, OSError) as exc:
            logger.error("TAK Connection error: %s. Retrying in 5s...", exc)
        await asyncio.sleep(5)


@app.on_event("startup")
async def startup_event() -> None:
    load_iconsets(ICONSETS_DIR, "/iconsets")
    load_iconsets(USER_ICONSETS_DIR, "/user_iconsets")
    asyncio.create_task(tak_client())


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.error("WebSocket error: %s", exc)
        manager.disconnect(websocket)


# Static File and Iconset Mounting
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
static_dir = os.path.join(BASE_DIR, "static")

if os.path.exists(static_dir):
    logger.info("Mounting static files from %s", static_dir)
    if os.path.exists(os.path.join(static_dir, "assets")):
        app.mount(
            "/assets",
            StaticFiles(directory=os.path.join(static_dir, "assets")),
            name="assets",
        )
    if os.path.exists(os.path.join(static_dir, "cesium")):
        app.mount(
            "/cesium",
            StaticFiles(directory=os.path.join(static_dir, "cesium")),
            name="cesium",
        )
    if os.path.exists(os.path.join(static_dir, "locales")):
        app.mount(
            "/locales",
            StaticFiles(directory=os.path.join(static_dir, "locales")),
            name="locales",
        )

if os.path.exists(ICONSETS_DIR):
    logger.info("Mounting iconsets from %s", ICONSETS_DIR)
    app.mount("/iconsets", StaticFiles(directory=ICONSETS_DIR), name="iconsets")

if os.path.exists(USER_ICONSETS_DIR):
    logger.info("Mounting user iconsets from %s", USER_ICONSETS_DIR)
    app.mount(
        "/user_iconsets", StaticFiles(directory=USER_ICONSETS_DIR), name="user_iconsets"
    )


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str) -> Any:
    # 1. Check if it's a static file
    if os.path.exists(static_dir):
        file_path = os.path.join(static_dir, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)

    # 2. Handle internal routes (don't serve index.html for these)
    if full_path.startswith(("ws", "api", "config", "iconsets")):
        return {"error": "Not Found"}

    # 3. Serve index.html for SPA routing
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)

    return {"message": "TAK Cesium Backend Running (No static frontend found)"}


if __name__ == "__main__":
    import uvicorn

    server_port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=server_port)
