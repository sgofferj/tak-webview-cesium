import asyncio
import logging

from fastapi import WebSocket
from fastapi.requests import HTTPConnection

from .config import settings

logger = logging.getLogger("tak-webview.connection")

def get_client_ip(connection: HTTPConnection) -> str:
    """Extracts the real client IP considering trusted proxies."""
    client_host = connection.client.host if connection.client else "unknown"
    
    # Check if the connecting host is a trusted proxy
    is_trusted = client_host in settings.trusted_proxies or any(
        client_host.startswith(tp) for tp in settings.trusted_proxies if "/" in tp
    )
    
    if is_trusted:
        # Standard header for forwarded IPs
        forwarded_for = connection.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
        
        # Fallback for some proxies
        real_ip = connection.headers.get("x-real-ip")
        if real_ip:
            return real_ip.strip()
            
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

    async def broadcast(self, message: str | bytes) -> None:
        if not self.active_connections:
            return
        await asyncio.gather(
            *(self._send_safe(conn, message) for conn in self.active_connections)
        )

    async def _send_safe(self, websocket: WebSocket, message: str | bytes) -> None:
        try:
            if isinstance(message, bytes):
                await websocket.send_bytes(message)
            else:
                await websocket.send_text(message)
        except Exception:
            # Connection likely closed, will be handled by disconnect
            pass

manager = ConnectionManager()
