#!/usr/bin/env python3
# main.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import asyncio
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from anyio import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import settings
from .connection import manager
from .iconsets import iconsets_cache, load_iconsets
from .layers import get_app_config, load_layers
from .tak_client import tak_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tak-webview.main")

# Store dynamic mounts to be applied to the app
ICONSET_MOUNTS: dict[str, str] = {}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup: Scan iconsets
    # We populate ICONSET_MOUNTS here, but they must be mounted on the app
    # StaticFiles mounts are usually added before the app starts.
    # However, in FastAPI, we can add them to the app.router.
    # For simplicity and reliability, we ensure the app object is available.

    # Load layers
    await load_layers()

    # Start TAK client
    asyncio.create_task(tak_client.run())

    yield
    # Shutdown
    await tak_client.stop()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Scan iconsets and mount them immediately
iconset_mounts = load_iconsets(settings.iconsets_dir, "/iconsets")
for uid, fs_path in iconset_mounts.items():
    app.mount(f"/iconsets/{uid}", StaticFiles(directory=fs_path), name=f"iconset-{uid}")

user_iconset_mounts = load_iconsets(settings.user_iconsets_dir, "/user_iconsets")
for uid, fs_path in user_iconset_mounts.items():
    app.mount(
        f"/user_iconsets/{uid}",
        StaticFiles(directory=fs_path),
        name=f"user-iconset-{uid}",
    )


# API Routes
@app.get("/config")
async def config() -> dict[str, Any]:
    return await get_app_config()


@app.get("/iconsets")
async def get_iconsets() -> dict[str, dict[str, Any]]:
    return iconsets_cache


@app.get("/logo")
async def get_logo() -> Response:
    if settings.logo and os.path.exists(settings.logo):
        return FileResponse(settings.logo)
    return Response(status_code=404)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            # Just keep connection alive, we only push data
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# Serve Static Files
frontend_dir = Path("frontend/dist")


@app.get("/")
async def serve_index() -> FileResponse:
    index_path = frontend_dir / "index.html"
    if await index_path.exists():
        return FileResponse(str(index_path))
    return FileResponse("frontend/index.html")


# Static files from dist (JS, CSS, etc.)
if os.path.exists("frontend/dist"):
    app.mount("/", StaticFiles(directory="frontend/dist"), name="static")
else:
    app.mount("/", StaticFiles(directory="frontend"), name="static")
