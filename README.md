# TAK Cesium Webview
A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

(C) 2026 Stefan Gofferje

Licensed under the GNU General Public License V3 or later.

## Description
This application provides a real-time 3D tactical view of Cursor-on-Target (CoT) data from a TAK Server using the CesiumJS engine. It is designed to be a lightweight, web-based alternative for situational awareness, supporting standard military symbology and various imagery providers.

### Features
- **Real-time Visualization:** View CoT data from TAK Server in a 3D CesiumJS environment.
- **MIL-STD-2525 Support:** Rendering of standard military symbols using `milsymbol`.
- **Custom Iconsets:** Support for TAK iconsets and custom imagery.
- **Dynamic Layer Configuration:** Configure multiple imagery providers (WMS, XYZ, ArcGIS) via a JSON file with automatic extent discovery.
- **Incident & Emergency Handling:** Visual alerts and centering for emergency messages.
- **Internationalization:** Multi-language support for the user interface.
- **Flexible Imagery:** Support for various imagery providers, including Finnish national mapping data.

## Security Note
**This software is designed to be used behind a reverse proxy (like Nginx, Traefik, or Apache).** It does not implement HTTPS or any form of authentication natively. For production deployments, you **must** use a reverse proxy to handle SSL/TLS termination and access control.

## Configuration
The following values are supported and can be provided either as environment variables or through an .env-file.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TAK_HOST` | `localhost` | Hostname or IP of the TAK Server |
| `TAK_PORT` | `8089` | TCP/TLS port of the TAK Server |
| `TAK_TLS_CLIENT_CERT` | `certs/cert.pem` | Path to the mTLS client certificate (PEM) |
| `TAK_TLS_CLIENT_KEY` | `certs/cert.key` | Path to the mTLS client private key (PEM) |
| `TAK_TLS_CA_CERT` | (Optional) | Path to the CA certificate for server verification |
| `TAK_CALLSIGN` | `CesiumViewer` | Callsign this viewer uses to identify itself to the server |
| `TAK_UID` | `CesiumViewer-[Callsign]` | Unique ID for the viewer entity |
| `ICONSETS_DIR` | `/iconsets` | Directory to scan for built-in iconsets |
| `USER_ICONSETS_DIR` | `/user_iconsets` | Additional directory to scan for user-installed iconsets |
| `TERRAIN_URL` | (Empty) | URL to a Cesium terrain provider (quantized-mesh or heightmap) |
| `LOG_COTS` | `false` | Set to `true` to log incoming CoT messages to the console |
| `CENTER_ALERT` | `false` | Automatically zoom and alert on new emergency messages |
| `TRUSTED_PROXIES` | `127.0.0.1` | Comma-separated list of IPs/CIDRs to trust for X-Forwarded-For |
| `PORT` | `8000` | The port the web server listens on inside the container |
| `CESIUM_ION_TOKEN` | (Empty) | Your Cesium Ion access token for Bing Maps and high-res terrain |
| `LOGO` | (Empty) | Path to a custom logo file within the container |
| `LOGO_POSITION` | `bottom_right` | Position of the logo: `top_left`, `top_center`, etc. |

### Custom Imagery Configuration
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

#### Supported Layer Types
- `wms`: Web Map Service.
- `xyz` / `tms`: Tiled map services using `{z}/{x}/{y}` templates.
- `arcgis`: ArcGIS MapServer layers.

#### Automatic Extent Discovery
For `wms` layers, if you omit the `rectangle` field, the backend will automatically attempt to fetch the layer's extent using a `GetCapabilities` request. You can also manually specify it as `[minLon, minLat, maxLon, maxLat]`.

## Getting Started
For instructions on how to set up the development environment, test, and deploy the application, please refer to the [DEVELOPMENT.md](./DEVELOPMENT.md) file.

### Quick Start (Docker)
First, rename `.env.example` to `.env` and edit according to your needs.
Create and start the container:

```yaml
services:
  tak-webview:
    image: ghcr.io/sgofferj/tak-webview-cesium:latest
    ports:
      - "${WEB_PORT:-8000}:8000"
    environment:
      - CESIUM_ION_TOKEN=${CESIUM_ION_TOKEN:-}
      - LOGO=${LOGO:-}
      - LOGO_POSITION=${LOGO_POSITION:-bottom_right}
    env_file:
      - .env
    volumes:
      - ./certs:/app/certs:ro
      - ./frontend/iconsets:/iconsets
      - ./user_iconsets:/user_iconsets
    restart: unless-stopped
```

1. Place your `cert.pem` and `cert.key` in the `./certs` directory.
2. Create a `.env` file based on the environment variables table above.
3. Run:
   ```bash
   docker compose up -d
   ```

## Support
If you have a question about the software or find a bug, please open an issue. Suggestions for improvements or pull requests are also welcome 😀.
