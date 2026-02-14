# Stage 1: Build the frontend
FROM node:20-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
# VITE_WS_HOST is not strictly needed if serving from the same host/port, 
# but we'll keep it for flexibility. If empty, the frontend uses window.location.host.
ARG VITE_WS_HOST=""
ENV VITE_WS_HOST=$VITE_WS_HOST
ARG VITE_CESIUM_ION_TOKEN=""
ENV VITE_CESIUM_ION_TOKEN=$VITE_CESIUM_ION_TOKEN
RUN npm run build

# Stage 2: Backend and combined serving
FROM python:3.11-slim
WORKDIR /app

# Install poetry
RUN pip install poetry

# Copy backend dependency files
COPY backend/pyproject.toml backend/poetry.lock* ./
RUN poetry config virtualenvs.create false \
    && poetry install --no-interaction --no-ansi --no-root

# Copy frontend build to a 'static' folder the backend expects
COPY --from=frontend-build /frontend/dist ./static

# Copy backend source code
COPY backend/ .

# Copy iconsets from frontend to the location the backend expects
COPY frontend/iconsets /iconsets

# Ensure necessary directories exist
RUN mkdir -p certs /user_iconsets

EXPOSE 8000

CMD ["python", "main.py"]
