# Building TAK Cesium Webview

This document describes how to set up the development environment and build the project for production.

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
docker compose build
```

### 2. Run the Container
```bash
docker compose up -d
```

The application will be available at `http://localhost:8000`.

## Environment Configuration

Copy `.env.example` to `.env` in both `backend` and `frontend` directories (or use a root `.env` if using Docker) and fill in your TAK Server details and Cesium Ion token.

---
*Developed with the assistance of an AI engineering agent.*
