# Server image — runs the FastAPI app and serves the prebuilt React
# bundle from /srv/claude-board/static. The bundle is baked in during
# the multi-stage build below so the image is self-contained.

# --- frontend build stage ---
FROM node:20-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- runtime stage ---
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BOARD_STATIC_DIR=/srv/claude-board/static \
    BOARD_DB_PATH=/var/lib/claude-board/board.db \
    BOARD_PORT=8200

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY server/pyproject.toml ./
COPY server/claude_board ./claude_board
RUN pip install --no-cache-dir .

# Copy the built frontend bundle into the place the server expects.
COPY --from=frontend /src/dist /srv/claude-board/static
COPY frontend/public/odin.png /srv/claude-board/static/odin.png

# Persistent SQLite + manifest store lives on a volume.
RUN mkdir -p /var/lib/claude-board && chown -R nobody:nogroup /var/lib/claude-board
VOLUME ["/var/lib/claude-board"]

USER nobody
EXPOSE 8200

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8200/healthz || exit 1

CMD ["python", "-m", "claude_board"]
