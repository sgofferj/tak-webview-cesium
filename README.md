# TAK Cesium Webview

A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

## Features

- **Real-time Visualization:** View CoT data from TAK Server in a 3D CesiumJS environment.
- **MIL-STD-2525 Support:** Rendering of standard military symbols using `milsymbol`.
- **Custom Iconsets:** Support for TAK iconsets and custom imagery.
- **Dynamic Layer Configuration:** Configure multiple imagery providers (WMS, XYZ, ArcGIS) via a JSON file with automatic extent discovery.
- **Incident & Emergency Handling:** Visual alerts and centering for emergency messages.
- **Internationalization:** Multi-language support for the user interface.
- **Flexible Imagery:** Support for various imagery providers, including Finnish national mapping data.

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
