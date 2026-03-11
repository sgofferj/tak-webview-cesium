# tak-webview-cesium
A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

(C) 2026 Stefan Gofferje

Licensed under the GNU General Public License V3 or later.

> [!CAUTION]
> The authentication and certificate management system has been completely refactored. Static certificate configurations are no longer supported. Please study the **Security Note**, **Configuration**, and **Quick Start** sections below for details on the new automated enrollment and login workflow.

## Description
This application provides a real-time 3D tactical view of Cursor-on-Target (CoT) data from a TAK Server using the CesiumJS engine. It is designed to be a lightweight, web-based alternative for situational awareness, supporting standard military symbology and various imagery providers.

### Features
- **Automated Certificate Enrollment:** Securely obtain mTLS certificates directly from your TAK Server (port 8446).
- **Silent Start & Authentication:** Ephemeral, session-based storage for certificates and hashed credentials with a "Silent Start" policy (no data shown until login).
- **Status Tray:** Persistent indicator for certificate Common Name (CN), expiry status (Green/Orange/Red), and real-time connection status.
- **Real-time Visualization:** View CoT data from TAK Server in a 3D CesiumJS environment.
- **MIL-STD-2525 Support:** Rendering of standard military symbols using `milsymbol`.
- **Custom Iconsets:** Support for TAK iconsets and custom imagery.
- **Dynamic Layer Configuration:** Configure multiple base maps (WMS, XYZ, ArcGIS) with automatic extent discovery.
- **Stackable Overlays:** Support for multiple simultaneous transparent overlay layers (e.g., OpenSeaMap, OpenAIP) on top of any base map.
- **Incident & Emergency Handling:** Visual alerts and centering for emergency messages.
- **Internationalization:** Multi-language support for the user interface.
- **Traffic Optimization:** Minified binary communication (MessagePack) and frequency throttling.

## Custom Layers & Overlays

You can configure your map layers in `customlayers.json`. Layers can be categorized and marked as overlays to allow for simultaneous display.

### Example `customlayers.json`

```json
[
  {
    "name": "Finnish Topo",
    "type": "wms",
    "url": "https://tiles.kartat.kapsi.fi/peruskartta?",
    "layers": "peruskartta",
    "attribution": "Maanmittauslaitos",
    "category": "Finland"
  },
  {
    "name": "OpenSeaMap",
    "type": "xyz",
    "url": "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    "attribution": "OpenSeaMap",
    "category": "Overlays",
    "is_overlay": true
  }
]
```

## Security Note
This application implements a rigorous, multi-layered security model designed to protect sensitive mission data and cryptographic identities:

- **Native Authentication:** No data is displayed or processed until the user successfully authenticates with the backend.
- **Automated mTLS Enrollment:** The connection to the TAK Server is secured using industry-standard mTLS. Certificates are obtained dynamically via the 8446 enrollment protocol using a simplified, automated workflow.
- **Secure Credential Handling:** User credentials for the web interface are never stored in plain text. They are hashed using `PBKDF2-HMAC-SHA256` with a unique random salt generated per enrollment session.
- **Ephemeral Storage & Auto-Wipe:** All session-related data (certificates, keys, and hashed credentials) is stored in an ephemeral volume. This data is **automatically wiped** upon manual logout, certificate expiration, or after 3 failed login attempts.

### Never-Unencrypted-on-Disk Philosophy
To maintain the highest possible security posture, this application ensures that your **private key never exists in cleartext on the filesystem**:

1.  **Transparent Encryption:** Upon enrollment, the private key is immediately encrypted using a strong `Fernet` (AES-128 in CBC mode with HMAC-SHA256) key derived from your login credentials. Only the encrypted blob is written to the persistent (ephemeral) volume.
2.  **RAM-Only Decryption:** When the application connects to the TAK Server, the private key is decrypted directly into RAM. 
3.  **Linux `memfd` Integration:** The application utilizes Linux-native `memfd_create` to create a virtual, RAM-backed file descriptor for the decrypted key. This allows the system to feed the private key to the standard SSL library without ever creating a temporary file on disk.
4.  **Zero-Knowledge Secrets:** The secrets used for CSR enrollment and key storage are derived deterministically from your login credentials and salts, removing the need for user-chosen (and often weak) certificate passwords.

**Note on Transport Encryption:** While the application handles authentication and mTLS natively, the web interface itself is served over standard HTTP. For production deployments, you **must** use a reverse proxy (e.g., Nginx, Traefik) to provide HTTPS transport encryption for the frontend-to-backend communication.

## Configuration
The following values are supported and can be provided either as environment variables or through an .env-file.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TAK_HOST` | `localhost` | Hostname or IP of the TAK Server |
| `TAK_PORT` | `8089` | TCP/TLS port of the TAK Server |
| `TAK_ENROLL_PORT` | `8446` | Enrollment port of the TAK Server |
| `TAK_CALLSIGN` | `CesiumViewer` | Callsign used for enrollment and identification |
| `TAK_UID` | `CesiumViewer-[Callsign]` | Unique ID for the viewer entity |
| `SECRET_KEY` | (Random) | Secret for signing session cookies (Regenerated on every restart by default) |
| `EPHEMERAL_DIR` | `certs/ephemeral` | Path to store temporary session certificates |
| `ICONSETS_DIR` | `/iconsets` | Directory to scan for built-in iconsets |
| `USER_ICONSETS_DIR` | `/user_iconsets` | Additional directory to scan for user-installed iconsets |
| `TERRAIN_URL` | (Empty) | URL to a Cesium terrain provider (quantized-mesh or heightmap) |
| `TERRAIN_EXAGGERATION` | `1.0` | Vertical exaggeration for terrain |
| `INITIAL_LAT` | `60.1699` | Initial latitude for map center |
| `INITIAL_LON` | `24.9384` | Initial longitude for map center |
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
1. Rename `.env.example` to `.env` and edit `TAK_HOST` to point to your server.
2. Ensure the `certs/ephemeral` directory (or your configured `EPHEMERAL_DIR`) is writable by the container.
3. Create and start the container:

```yaml
services:
  tak-webview:
    image: ghcr.io/sgofferj/tak-webview-cesium:latest
    ports:
      - "8000:8000"
    env_file:
      - .env
    volumes:
      - ./certs:/app/certs:rw
      - ./customlayers.json:/app/customlayers.json:ro
      - ./user_iconsets:/user_iconsets:ro
    restart: unless-stopped
```

4. Run:
   ```bash
   docker compose up -d
   ```
5. Open the web interface. You will be prompted to **Enroll** with your TAK Server credentials.
6. Once enrolled, you will **Login** to start the real-time data flow.

## Support
If you have a question about the software or find a bug, please open an issue. Suggestions for improvements or pull requests are also welcome 😀.
