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
from .clients import ClientPool
from .config import settings
from .connection import manager, tracker
from .iconsets import iconsets_cache, load_iconsets
from .layers import get_app_config, load_layers
from .tak_client import Identity
from .users import uid_for_username

pool = ClientPool()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("tak-webview.main")

# CoT capture logs at DEBUG; raise the tak and main modules to DEBUG when
# requested so LOG_COTS=true shows traffic and the ws chat_send routing.
if settings.log_cots:
    logging.getLogger("tak-webview.tak").setLevel(logging.DEBUG)
    logging.getLogger("tak-webview.main").setLevel(logging.DEBUG)


class HealthCheckLogFilter(logging.Filter):
    """Suppress access-log noise from haproxy alive checks."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(HealthCheckLogFilter())

# FastAPI access logging is handled by uvicorn; this keeps health checks quiet
logger.info("Health checks on /health are excluded from the access log.")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    await load_layers()

    # In dynamic session-based mode, the TAK client starts ONLY
    # when a user actively logs in.
    logger.info("Application startup. Waiting for user login to start TAK client.")
    if settings.force_server:
        logger.info("Server forced to %s", settings.force_server)
    yield
    # Shutdown
    await pool.stop_all()


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
    username = tracker.username_for(request.session.get("sid"))
    if authenticated and username:
        enrolled = auth_manager.is_user_enrolled(username)
        cert = auth_manager.get_cert_info(username)
        user_server = auth_manager.user_server(username)
    else:
        enrolled = auth_manager.is_enrolled()
        cert = None
        user_server = None
    return {
        "enrolled": enrolled,
        "authenticated": authenticated,
        "username": username,
        "cert": cert,
        "userServer": user_server,
        "pinnedServer": auth_manager.get_pinned_server(),
        "forceServer": settings.force_server,
    }


@app.post("/api/auth/enroll")
async def auth_enroll(req: EnrollRequest, request: Request) -> dict[str, Any]:
    ok, server = auth_manager.decide_server(req.server)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="TAK Server does not match the server pinned for this install",
        )
    assert server is not None
    success = await auth_manager.enroll(server, req.username, req.password)
    if not success:
        raise HTTPException(status_code=401, detail="Enrollment failed")

    # Automatically authenticate after enrollment
    request.session["authenticated"] = True
    request.session["username"] = req.username
    request.session["sid"] = secrets.token_hex(16)
    tracker.register(request.session["sid"], req.username)
    auth_manager.reset_failed_logins(req.username)
    # TAK client will start when messaging config is saved
    reset_messaging_config(req.username)
    # Return the server-pushed profile (if any) so the frontend can prefill
    # the config popup: server profile > localStorage > defaults.
    return {
        "status": "success",
        "username": req.username,
        "profile": auth_manager.enrollment_profile,
    }


@app.post("/api/auth/upload-p12")
async def auth_upload_p12(
    request: Request,
    file: UploadFile = File(...),
    password: str = Form(...),
    new_password: str | None = Form(None),
    server: str = Form(""),
) -> dict[str, Any]:
    # pylint: disable=too-many-arguments
    ok, decided_server = auth_manager.decide_server(server)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="TAK Server does not match the server pinned for this install",
        )
    assert decided_server is not None
    p12_data = await file.read()
    username = auth_manager.upload_p12(p12_data, password, new_password, decided_server)
    if not username:
        # If decryption fails, we can't extract the username yet.
        # Failures can be due to wrong password or insecure password requirements.
        raise HTTPException(
            status_code=401, detail="P12 import failed. Check password and file."
        )

    # Automatically authenticate after upload
    request.session["authenticated"] = True
    request.session["username"] = username
    request.session["sid"] = secrets.token_hex(16)
    tracker.register(request.session["sid"], username)
    auth_manager.reset_failed_logins(username)
    reset_messaging_config(username)
    return {"status": "success", "username": username}


@app.post("/api/auth/login")
async def auth_login(req: LoginRequest, request: Request) -> dict[str, Any]:
    if not auth_manager.is_enrolled():
        raise HTTPException(status_code=400, detail="Not enrolled")

    # Check expiry
    cert_info = auth_manager.get_cert_info(req.username)
    if cert_info and cert_info.get("status") == "expired":
        auth_manager.wipe_user(req.username)
        raise HTTPException(status_code=401, detail="Certificate expired")

    if auth_manager.login(req.username, req.password):
        request.session["authenticated"] = True
        request.session["username"] = req.username
        request.session["sid"] = secrets.token_hex(16)
        tracker.register(request.session["sid"], req.username)
        auth_manager.reset_failed_logins(req.username)
        # TAK client will start when messaging config is saved
        return {"status": "success", "username": req.username}

    attempts = auth_manager.record_failed_login(req.username)
    if attempts >= 3:
        auth_manager.wipe_user(req.username)
        request.session.clear()
        detail = "Max attempts reached. Enrollment wiped."
        raise HTTPException(status_code=401, detail=detail)

    raise HTTPException(status_code=401, detail="Invalid credentials")


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> dict[str, Any]:
    """Session logout only - keeps certificates."""
    sid = request.session.get("sid")
    if not sid:
        tracker.reset()
        await pool.stop_all()
    else:
        username = tracker.unregister(sid)
        if username:
            # Stop this user's TAK client once their last tab is gone
            if manager.count_for(username) == 0:
                await pool.stop_user(username)
            # Drop the RAM-only key once the user's last session is gone
            if not tracker.sessions_for(username):
                auth_manager.drop_session(username)
    request.session.clear()
    return {"status": "success"}


@app.post("/api/auth/logout-wipe")
async def auth_logout_wipe(request: Request) -> dict[str, Any]:
    """Full logout: delete only the logged-in user's records."""
    sid = request.session.get("sid")
    username = None
    if sid:
        username = tracker.unregister(sid)
    else:
        tracker.reset()
    if username:
        # Certificates are gone - the connection cannot be sustained
        await pool.stop_user(username)
        auth_manager.wipe_user(username)
        reset_messaging_config(username)
    else:
        # Legacy fallback when the sid could not be attributed
        await pool.stop_all()
        auth_manager.wipe_ephemeral()
        reset_messaging_config(None)
    request.session.clear()
    return {"status": "success"}


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe for load balancers. Excluded from the access log."""
    return {"status": "ok"}


@app.get("/config")
async def config() -> dict[str, Any]:
    return await get_app_config()


# Per-user messaging config (callsign/color/role), RAM only.
messaging_config: dict[str, dict[str, str]] = {}


def reset_messaging_config(username: str | None) -> None:
    """Clear saved messaging config so a TAK client cannot auto-start.

    Called when the authentication context changes (new enrollment, upload or
    full logout); the TAK client only starts after the user confirms a fresh
    config in the config overlay.
    """
    if username:
        messaging_config.pop(username, None)
    else:
        messaging_config.clear()


def _user_identity(username: str, cfg: dict[str, str]) -> Identity:
    """Per-user identity: stable UID + the user's callsign/color/role/server."""
    account = auth_manager.registry.get_account(username)
    uid = account.uid if account and account.uid else uid_for_username(username)
    return Identity(
        username=username,
        uid=uid,
        callsign=cfg.get("callsign") or settings.tak_callsign,
        color=cfg.get("color") or "",
        role=cfg.get("role") or "",
        server=auth_manager.user_server(username) or settings.tak_host,
    )


async def _start_user_client(username: str) -> None:
    """Ensure the user's own TAK client is running with their saved config.

    Each logged-in user gets a distinct TAK connection (multiuser), so two
    users on one install each appear as their own session/client on the TAK
    server and can see each other. The client only starts once the user
    confirmed callsign+color+role in the config overlay.
    """
    cfg = messaging_config.get(username)
    if (
        not cfg
        or not cfg.get("callsign")
        or not cfg.get("color")
        or not cfg.get("role")
    ):
        logger.info("TAK client for %s not started: messaging config not set", username)
        return
    identity = _user_identity(username, cfg)
    client = pool.client(identity.server, username, identity)
    if not client.is_running:
        await client.start()


# ----------------------------------------------------------------------
#  Endpoints for messaging configuration (callsign, colour, role)
# ----------------------------------------------------------------------


@app.post("/api/messaging/config")
async def set_messaging_config(req: dict[str, str], request: Request) -> dict[str, Any]:
    username = tracker.username_for(request.session.get("sid"))
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")

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
    messaging_config[username] = {
        "callsign": callsign,
        "color": color,
        "role": role,
    }

    # Start (or reconnect) this user's own TAK client with their identity.
    identity = _user_identity(username, messaging_config[username])
    client = pool.client(identity.server, username, identity)
    if client.is_running:
        await client.update_config(callsign=callsign, color=color, role=role)
    else:
        await client.start()

    return {"status": "ok"}


@app.get("/api/messaging/config")
async def get_messaging_config(request: Request) -> dict[str, str]:
    username = tracker.username_for(request.session.get("sid"))
    if not username:
        return {}
    return dict(messaging_config.get(username, {}))


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
    username = tracker.username_for(sid)
    if not username:
        await websocket.accept()
        await websocket.close(code=4001)
        return
    tracker.ws_opened(sid)
    try:
        await manager.connect(websocket, username)
    except (WebSocketDisconnect, RuntimeError):
        tracker.ws_closed(sid)
        return
    # A web client is now viewing: make sure THIS user's TAK connection is up.
    if not pool.is_running(username):
        await _start_user_client(username)
    client = pool.client_for(username)
    # Give the new client the current chat state (history, contacts, self).
    try:
        if client:
            await websocket.send_text(json.dumps({"chat_init": client.chat_snapshot()}))
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            cs = msg.get("chat_send")
            cr = msg.get("chat_read")
            if not isinstance(cs, dict) and not isinstance(cr, dict):
                continue
            # Look the client up per message: the user may have confirmed the
            # messaging config AFTER this socket connected, so a single
            # pre-loop lookup could have captured client=None and every send
            # would be dropped.
            if client is None:
                await _start_user_client(username)
                client = pool.client_for(username)
            if client is None:
                logger.warning(
                    "chat_send dropped for %s: no TAK client bound", username
                )
                continue
            if isinstance(cr, dict):
                message_id = str(cr.get("message_id") or "")
                if message_id:
                    await client.send_chat_read(message_id)
                continue
            logger.debug(
                "chat_send: room=%s, peer_uid=%s, peer_callsign=%s, text=%s, "
                "client_id=%s",
                cs.get("room"),
                cs.get("peer_uid"),
                cs.get("peer_callsign"),
                cs.get("text"),
                cs.get("client_id"),
            )
            try:
                await client.send_chat(
                    room=str(cs.get("room") or "All Chat Rooms"),
                    peer_uid=cs.get("peer_uid"),
                    peer_callsign=cs.get("peer_callsign"),
                    text=str(cs.get("text") or ""),
                    client_id=str(cs.get("client_id") or ""),
                )
            except ValueError as e:
                try:
                    await websocket.send_text(json.dumps({"chat_error": str(e)}))
                except WebSocketDisconnect:
                    break
            except WebSocketDisconnect:
                break
    finally:
        manager.disconnect(websocket)
        tracker.ws_closed(sid)
        # No tab left for this user: close their TAK connection until one
        # returns. Other users' connections stay untouched.
        if manager.count_for(username) == 0:
            await pool.stop_user(username)


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
