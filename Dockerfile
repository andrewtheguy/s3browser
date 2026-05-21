# --- Frontend stage: build static assets with Bun ---
FROM oven/bun:1.3-alpine AS frontend-builder
WORKDIR /app

COPY frontend ./frontend
RUN cd frontend && bun install --frozen-lockfile && bun run build

# --- Builder stage: install the s3browser Python project ---
FROM python:3.12-slim-bookworm AS builder

RUN apt-get -yqq update && \
    apt-get install -yq --no-install-recommends ca-certificates && \
    apt-get autoremove -y && \
    apt-get clean -y && rm -rf /var/lib/apt/lists/*

ENV app=/usr/src/app
WORKDIR $app

# Copy lock + metadata first for better layer caching
COPY pyproject.toml uv.lock README.md ./
# Frontend assets are force-included into s3browser/static by the wheel build (see pyproject.toml)
COPY --from=frontend-builder /app/dist ./dist

ENV UV_PROJECT_ENVIRONMENT="/usr/local/"
RUN --mount=from=ghcr.io/astral-sh/uv:0.9.11,source=/uv,target=/uv \
    /uv sync --locked --no-dev --no-editable --no-install-project

# Copy application code
COPY s3browser ./s3browser

# Install the project itself (builds & installs the wheel, embedding dist/ as s3browser/static)
RUN --mount=from=ghcr.io/astral-sh/uv:0.9.11,source=/uv,target=/uv \
    /uv sync --locked --no-dev --no-editable

# --- Runtime stage: minimal Python image ---
FROM python:3.12-slim-bookworm

RUN apt-get -yqq update && \
    apt-get install -yq --no-install-recommends ca-certificates tini && \
    apt-get autoremove -y && \
    apt-get clean -y && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/s3browser /usr/local/bin/s3browser

EXPOSE 8170

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["s3browser", "server", "--bind", ":8170"]
