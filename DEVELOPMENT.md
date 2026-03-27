# Development and Deployment
This document describes how to set up the local development environment, run tests, and deploy the project.

(C) 2025 Stefan Gofferje

Licensed under the GNU General Public License V3 or later.

## Prerequisites
- **Node.js**: Version 20 or later.
- **Python**: Version 3.11 or later.
- **Poetry**: Python dependency management.
- **Docker**: For production deployment.

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
docker build -t tak-webview-cesium .
```

### 2. Run the Container
You can run it directly with `docker run` or use `docker compose`.

#### Using Docker Compose
You can create a `docker-compose.yml` file to manage the container:

```yaml
services:
  tak-webview:
    image: tak-webview-cesium:latest
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

Then run:
```bash
docker compose up -d
```

#### Using Docker Run
```bash
docker run -d \
  -p 8000:8000 \
  -e TAK_HOST=192.168.1.10 \
  -e CESIUM_ION_TOKEN=your_token \
  -v ./certs:/app/certs:ro \
  tak-webview-cesium
```

## Deployment
1. Ensure the `certs/ephemeral` directory (hardcoded to `/app/certs/ephemeral` in container) is writable.
2. Create a `.env` file based on the documentation in the main `README.md`.
3. Run with Docker Compose:
   ```bash
   docker compose up -d --build
   ```

## Multi-Architecture Support
The project includes a GitHub Action to build and push images for both `amd64` and `arm64` architectures.
