# TAK Cesium Webview

A unified web application for visualizing Cursor-on-Target (CoT) data from a TAK Server using CesiumJS.

## Features

- **Real-time Visualization:** View CoT data from TAK Server in a 3D CesiumJS environment.
- **MIL-STD-2525 Support:** Rendering of standard military symbols using `milsymbol`.
- **Custom Iconsets:** Support for TAK iconsets and custom imagery.
- **Incident & Emergency Handling:** Visual alerts and centering for emergency messages.
- **Internationalization:** Multi-language support for the user interface.
- **Flexible Imagery:** Support for various imagery providers, including Finnish national mapping data.

## Getting Started

For instructions on how to build, configure, and deploy the application, please refer to the [BUILDING.md](./BUILDING.md) file.

### Quick Start (Docker)

If you have Docker and Docker Compose installed:

1. Place your `cert.pem` and `cert.key` in the `./certs` directory.
2. Create a `.env` file (see [BUILDING.md](./BUILDING.md) for details).
3. Run:
   ```bash
   docker compose up -d --build
   ```

---
*Developed with the assistance of an AI engineering agent.*
