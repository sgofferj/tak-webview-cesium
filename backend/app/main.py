#!/usr/bin/env python3
# main.py from https://github.com/sgofferj/tak-webview-cesium
#
# Copyright Stefan Gofferje
#
# Licensed under the Gnu General Public License Version 3 or higher (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

import json
import logging
import os
import secrets
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from anyio import Path
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from .auth import auth_manager
from .config import settings
from .connection import manager, tracker
from .iconsets import iconsets_cache, load_iconsets
from .layers import get_app_config, load_layers
from .tak_client import tak_client

# Wire TAK client to broadcast entities to websockets
tak_client.on_cot = tak_client._broadcast_if_needed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tak-webview.main")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    await load_layers()

    # In dynamic session-based mode, the TAK client starts ONLY
    # when a user actively logs in.
    logger.info("Application startup. Waiting for user login to start TAK client.")
    yield
    # Shutdown
    await tak_client.stop()


app = FastAPI(lifespan=lifespan)
# Session management - max_age=None makes it a session-only cookie
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="tak_webview_session",
    max_age=None,
)

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
@app.get("/api/overlays/{filename}")
async def get_overlay_file(filename: str) -> FileResponse:
    file_path = os.path.join(settings.overlays_dir, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="Overlay file not found")


class LoginRequest(BaseModel):
    username: str
    password: str


class EnrollRequest(BaseModel):
    server: str
    username: str
    password: str


@app.get("/api/auth/status")
async def auth_status(request: Request) -> dict[str, Any]:
    authenticated = request.session.get("authenticated", False)
    return {
        "enrolled": auth_manager.is_enrolled(),
        "authenticated": authenticated,
        "cert": auth_manager.get_cert_info(),
    }


@app.post("/api/auth/enroll")
async def auth_enroll(req: EnrollRequest, request: Request) -> dict[str, Any]:
    success = await auth_manager.enroll(req.server, req.username, req.password)
    if not success:
        raise HTTPException(status_code=401, detail="Enrollment failed")

    # Automatically authenticate after enrollment
    request.session["authenticated"] = True
    request.session["sid"] = secrets.token_hex(16)
    tracker.register(request.session["sid"])
    auth_manager.failed_attempts = 0
    # TAK client will start when messaging config is saved
    return {"status": "success"}


@app.post("/api/auth/upload-p12")
async def auth_upload_p12(
    request: Request,
    file: UploadFile = File(...),
    password: str = Form(...),
    new_password: str | None = Form(None),
    server: str = Form("imported"),
) -> dict[str, Any]:
    # pylint: disable=too-many-arguments
    p12_data = await file.read()
    username = auth_manager.upload_p12(p12_data, password, new_password, server)
    if not username:
        # If decryption fails, we can't extract the username yet.
        # Failures can be due to wrong password or insecure password requirements.
        raise HTTPException(
            status_code=401, detail="P12 import failed. Check password and file."
        )

    # Automatically authenticate after upload
    request.session["authenticated"] = True
    request.session["sid"] = secrets.token_hex(16)
    tracker.register(request.session["sid"])
    auth_manager.failed_attempts = 0
    # TAK client will start when messaging config is saved
    return {"status": "success", "username": username}


@app.post("/api/auth/login")
async def auth_login(req: LoginRequest, request: Request) -> dict[str, Any]:
    if not auth_manager.is_enrolled():
        raise HTTPException(status_code=400, detail="Not enrolled")

    # Check expiry
    cert_info = auth_manager.get_cert_info()
    if cert_info and cert_info.get("status") == "expired":
        auth_manager.wipe_ephemeral()
        raise HTTPException(status_code=401, detail="Certificate expired")

    if auth_manager.verify_credentials(req.username, req.password):
        request.session["authenticated"] = True
        request.session["sid"] = secrets.token_hex(16)
        tracker.register(request.session["sid"])
        auth_manager.failed_attempts = 0
        # TAK client will start when messaging config is saved
        return {"status": "success"}

    auth_manager.failed_attempts += 1
    if auth_manager.failed_attempts >= 3:
        auth_manager.wipe_ephemeral()
        request.session.clear()
        detail = "Max attempts reached. Ephemeral storage wiped."
        raise HTTPException(status_code=401, detail=detail)

    raise HTTPException(status_code=401, detail="Invalid credentials")


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> dict[str, Any]:
    """Session logout only - keeps certificates."""
    sid = request.session.get("sid")
    if sid:
        tracker.unregister(sid)
    else:
        tracker.reset()
    # Stop the TAK connection only when no web client is left
    if not tracker.active:
        await tak_client.stop()
    request.session.clear()
    return {"status": "success"}


@app.post("/api/auth/logout-wipe")
async def auth_logout_wipe(request: Request) -> dict[str, Any]:
    """Full logout and wipe of ephemeral storage."""
    sid = request.session.get("sid")
    if sid:
        tracker.unregister(sid)
    else:
        tracker.reset()
    # Certificates are gone - the connection cannot be sustained
    await tak_client.stop()
    auth_manager.wipe_ephemeral()
    request.session.clear()
    return {"status": "success"}


@app.get("/config")
async def config() -> dict[str, Any]:
    return await get_app_config()


messaging_config: dict[str, str] = {"callsign": "", "color": "", "role": ""}

# ----------------------------------------------------------------------
#  Endpoints for messaging configuration (callsign, colour, role)
# ----------------------------------------------------------------------
from fastapi import HTTPException


@app.post("/api/messaging/config")
async def set_messaging_config(req: dict[str, str]) -> dict[str, Any]:
    global messaging_config
    callsign = req.get("callsign", "") or ""
    color = req.get("color", "") or ""
    role = req.get("role", "") or ""
    # validate colour
    from .config import Settings

    valid_colors = Settings.VALID_COLOURS
    valid_roles = Settings.VALID_ROLES
    if color and color not in valid_colors:
        raise HTTPException(status_code=400, detail="Invalid colour")
    if role and role not in valid_roles:
        raise HTTPException(status_code=400, detail="Invalid role")
    messaging_config["callsign"] = callsign
    messaging_config["color"] = color
    messaging_config["role"] = role

    # Update settings for TAK client
    settings.tak_callsign_input = callsign
    settings.tak_color = color
    settings.tak_role = role

    # Start or reconnect TAK client with new config
    if tak_client._run_task is None or tak_client._run_task.done():
        await tak_client.start()
    else:
        tak_client.update_config(callsign=callsign, color=color, role=role)

    return {"status": "ok"}


@app.get("/api/messaging/config")
async def get_messaging_config() -> dict[str, str]:
    return dict(messaging_config)


@app.get("/iconsets")
async def get_iconsets() -> dict[str, dict[str, Any]]:
    return iconsets_cache


@app.get("/logo")
async def get_logo() -> Response:
    if settings.logo:
        logo_path = Path(settings.logo)
        if await logo_path.exists():
            return FileResponse(str(logo_path))
    return Response(status_code=404)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    # Check session auth for websocket as well
    session = websocket.scope.get("session", {})
    if not session.get("authenticated") or not session.get("sid"):
        await websocket.accept()
        await websocket.close(code=4001)
        return

    sid = session["sid"]
    tracker.ws_opened(sid)
    try:
        await manager.connect(websocket)
    except (WebSocketDisconnect, RuntimeError):
        tracker.ws_closed(sid)
        return
    # A web client is now viewing: make sure the TAK connection is up.
    # Only start if messaging config has been saved (callsign + color + role)
    if not tak_client.is_running:
        if settings.tak_callsign_input and settings.tak_color and settings.tak_role:
            await tak_client.start()
        else:
            logger.info("TAK client not started: messaging config not set")
    # Give the new client the current chat state (history, contacts, self).
    await websocket.send_text(json.dumps({"chat_init": tak_client.chat_snapshot()}))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            cs = msg.get("chat_send")
            if not isinstance(cs, dict):
                continue
            logger.debug(f"chat_send: room={cs.get('room')}, peer_uid={cs.get('peer_uid')}, peer_callsign={cs.get('peer_callsign')}, text={cs.get('text')}, client_id={cs.get('client_id')}")
            try:
                await tak_client.send_chat(
                    room=str(cs.get("room") or "All Chat Rooms"),
                    peer_uid=cs.get("peer_uid"),
                    peer_callsign=cs.get("peer_callsign"),
                    text=str(cs.get("text") or ""),
                    client_id=str(cs.get("client_id") or ""),
                )
            except ValueError as e:
                await websocket.send_text(json.dumps({"chat_error": str(e)}))
        pass
    finally:
        manager.disconnect(websocket)
        tracker.ws_closed(sid)
        # No web client left: close the TAK connection until one returns.
        if not tracker.active:
            await tak_client.stop()


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
