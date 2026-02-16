# Building TAK Cesium Webview

This document describes how to set up the development environment and build the project for production.

## Prerequisites

- **Node.js**: Version 20 or later.
- **Python**: Version 3.11 or later.
- **Poetry**: Python dependency management.
- **Docker**: For production deployment.

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
| `TERRAIN_URL` | URL to a Cesium terrain provider (quantized-mesh or heightmap). | (Empty) |
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

## Local Development Setup

### 1. Initialize Git and Pre-commit Hooks

The project uses `pre-commit` to ensure code quality.

```bash
# In the project root
python3 -m venv venv
source venv/bin/activate
pip install pre-commit poetry
pre-commit install
```

### 2. Backend Setup

```bash
cd backend
poetry install
```

To run the backend in development mode:
```bash
poetry run python main.py
```

### 3. Frontend Setup

```bash
cd frontend
npm install
```

To run the frontend in development mode (with Hot Module Replacement):
```bash
npm run dev
```

The frontend will be available at `http://localhost:5173`. By default, it expects the backend to be running on `localhost:8000`.

## Testing and Linting

Before committing, you can run all checks manually:

### Backend
```bash
cd backend
poetry run ruff check .
poetry run mypy .
poetry run pytest
```

### Frontend
```bash
cd frontend
npm run lint
npm run test
```

## Production Build (Docker)

The project is designed to be deployed as a single, unified Docker container.

### 1. Build the Image
```bash
# In the project root
docker compose build
```

### 2. Run the Container
```bash
docker compose up -d
```

The application will be available at `http://localhost:8000`.

## Deployment

1. Place your `cert.pem` and `cert.key` in the `./certs` directory.
2. Create a `.env` file based on the documentation in the main `README.md`.
3. Run with Docker Compose:
   ```bash
   docker compose up -d --build
   ```

## Multi-Architecture Support

The project includes a GitHub Action to build and push images for both `amd64` and `arm64` architectures.

## Custom Imagery Configuration

You can configure custom map layers by creating a `customlayers.json` file in the project root. This file is a JSON array of layer objects.

Example `customlayers.json`:
```json
[
  {
    "name": "My WMS Layer",
    "type": "wms",
    "url": "https://example.com/wms?",
    "layers": "my_layer_name",
    "attribution": "© My Provider"
  },
  {
    "name": "OpenStreetMap",
    "type": "xyz",
    "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "attribution": "© OpenStreetMap contributors"
  }
]
```

### Supported Layer Types
- `wms`: Web Map Service.
- `xyz` / `tms`: Tiled map services using `{z}/{x}/{y}` templates.
- `arcgis`: ArcGIS MapServer layers.

### Automatic Extent Discovery
For `wms` layers, if you omit the `rectangle` field, the backend will automatically attempt to fetch the layer's extent using a `GetCapabilities` request. You can also manually specify it as `[minLon, minLat, maxLon, maxLat]`.

## Environment Configuration

Copy `.env.example` to `.env` in both `backend` and `frontend` directories (or use a root `.env` if using Docker) and fill in your TAK Server details and Cesium Ion token.

---
*Developed with the assistance of an AI engineering agent.*
