# TAK Cesium Backend

This is the backend for the TAK Cesium Viewer. It connects to a TAK Server via TCP (mTLS) and streams CoT events to the frontend via WebSockets.

## Requirements

*   Python 3.11+
*   Poetry

## Setup

1.  Install dependencies:
    ```bash
    poetry install
    ```
2.  Configure environment variables in `.env` (see below).
3.  Run the server:
    ```bash
    poetry run uvicorn main:app --reload
    ```

## Environment Variables

*   `TAK_HOST`: TAK Server hostname (default: localhost)
*   `TAK_PORT`: TAK Server port (default: 8089)
*   `TAK_TLS_CLIENT_CERT`: Path to client certificate
*   `TAK_TLS_CLIENT_KEY`: Path to client key
*   `TAK_TLS_CA_CERT`: Path to CA certificate (optional)
