# Stage 1: Build the frontend
FROM node:20-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
ARG VITE_WS_HOST=""
ENV VITE_WS_HOST=$VITE_WS_HOST
ARG VITE_CESIUM_ION_TOKEN=""
ENV VITE_CESIUM_ION_TOKEN=$VITE_CESIUM_ION_TOKEN
RUN npm run build

# Stage 2: Backend and combined serving
FROM python:3.11-slim
WORKDIR /app

# Copy backend dependency files
COPY backend/pyproject.toml ./
RUN pip install poetry && poetry config virtualenvs.create false \
    && poetry install --no-interaction --no-ansi --no-root --no-directory

COPY backend/main.py ./
COPY backend/app ./app
COPY customlayers.json ./

# Copy frontend build to the location backend expects (frontend/dist relative to project root)
# The backend app/main.py expects static_dir = BASE_DIR/frontend/dist
# where BASE_DIR is project root.
# In the container, /app is the project root.
COPY --from=frontend-build /frontend/dist ./frontend/dist

# Copy iconsets
COPY frontend/iconsets /iconsets

# Ensure necessary directories exist
RUN mkdir -p certs /user_iconsets

EXPOSE 8000

CMD ["python", "main.py"]
