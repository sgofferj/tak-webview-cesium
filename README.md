# TAK Cesium Webview

A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

## Features

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

## Getting Started

For instructions on how to build, configure, and deploy the application, please refer to the [BUILDING.md](./BUILDING.md) file.

### Quick Start (Docker)

If you have Docker installed, you can run the application by creating a `docker-compose.yml` file:

```yaml
services:
  tak-webview:
    image: ghcr.io/sgofferj/tak-webview-cesium:latest
    ports:
      - "${WEB_PORT:-8000}:8000"
    environment:
      - CESIUM_ION_TOKEN=${CESIUM_ION_TOKEN:-}
      - INITIAL_LAT=${INITIAL_LAT:-60.1699}
      - INITIAL_LON=${INITIAL_LON:-24.9384}
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
2. Create a `.env` file (see [BUILDING.md](./BUILDING.md) for details).
3. Run:
   ```bash
   docker compose up -d
   ```

---
*Developed with the assistance of an AI engineering agent.*
