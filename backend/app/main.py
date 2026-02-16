import asyncio
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from anyio import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .connection import manager
from .iconsets import iconsets_cache, load_iconsets
from .tak_client import TAKClient

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tak-webview")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
static_dir = os.path.join(BASE_DIR, "frontend", "dist")

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    logger.info("Static directory: %s", static_dir)
    if not os.path.exists(static_dir):
        logger.error("Static directory NOT FOUND!")
    
    load_iconsets(settings.iconsets_dir, "/iconsets")
    load_iconsets(settings.user_iconsets_dir, "/user_iconsets")

    client = TAKClient(settings, manager.broadcast)
    tak_task = asyncio.create_task(client.run())

    yield

    # Shutdown
    client.stop()
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
        "imagery_layers": settings.imagery_layers,
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
