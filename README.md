# TAK Cesium Webview

A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

## Environment Variables

### Backend Configuration (Runtime)
These variables control the backend connection to the TAK Server and the local API server.

| Variable | Description | Default |
|----------|-------------|---------|
| `TAK_HOST` | Hostname or IP of the TAK Server. | `localhost` |
| `TAK_PORT` | TCP/TLS port of the TAK Server. | `8089` |
| `TAK_TLS_CLIENT_CERT` | Path to the mTLS client certificate (PEM). | `certs/cert.pem` |
| `TAK_TLS_CLIENT_KEY` | Path to the mTLS client private key (PEM). | `certs/cert.key` |
| `TAK_TLS_CA_CERT` | Path to the CA certificate for server verification. | (Optional) |
| `TAK_CALLSIGN` | The callsign this viewer uses to identify itself to the server. | `CesiumViewer` |
| `TAK_UID` | Unique ID for the viewer entity. | `CesiumViewer-[Callsign]` |
| `ICONSETS_DIR` | Directory to scan for built-in iconsets. | `/iconsets` |
| `USER_ICONSETS_DIR` | Additional directory to scan for user-installed iconsets. | `/user_iconsets` |
| `LOG_COTS` | Set to `true` to log incoming CoT messages to the console. | `false` |
| `CENTER_ALERT` | Automatically zoom and alert on new emergency messages. | `false` |
| `TRUSTED_PROXIES` | Comma-separated list of IP addresses/CIDRs to trust for X-Forwarded-For logging. | `127.0.0.1` |
| `PORT` | The port the web server listens on inside the container. | `8000` |

### Frontend Configuration (Build-time)
These variables are baked into the frontend during the Docker build process.

| Variable | Description | Default |
|----------|-------------|---------|
| `CESIUM_ION_TOKEN` | Your Cesium Ion access token for Bing Maps and high-res terrain. | (Empty) |
| `VITE_WS_HOST` | Override the WebSocket host if the frontend needs to connect to a different port/IP. | (Defaults to window.location.host) |

### Docker Compose Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_PORT` | The host port mapped to the container's web server. | `8000` |

## Deployment

1. Place your `cert.pem` and `cert.key` in the `./certs` directory.
2. Create a `.env` file based on the documentation above.
3. Run with Docker Compose:
   ```bash
   docker compose up -d --build
   ```

## Mult-Architecture Support
The project includes a GitHub Action to build and push images for both `amd64` and `arm64` architectures.

---
*Developed with the assistance of an AI engineering agent.*
