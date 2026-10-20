# Build stage
FROM rust:1.98-slim-trixie AS builder
ARG TARGETARCH

# Install build dependencies and bun
RUN apt-get update && apt-get install -y \
    build-essential \
    clang \
    mold \
    pkg-config \
    curl \
    unzip \
    && curl -fsSL https://bun.sh/install | bash \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /build

COPY . .

RUN cd frontend && bun install --frozen-lockfile

# Build the release binary (build.rs builds and embeds the frontend) with architecture-specific cache mounts
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=cargo-registry-v2-${TARGETARCH} \
    --mount=type=cache,target=/build/target,id=cargo-target-v2-${TARGETARCH} \
    cargo build --release --locked && \
    cp target/release/s3browser /s3browser

# Shared runtime base: CA roots for S3 over HTTPS, tini as PID 1, and a
# non-root user whose ~/.s3browser holds the database and secrets.
FROM debian:trixie-slim AS runtime-base

LABEL org.opencontainers.image.source=https://github.com/andrewtheguy/s3browser

RUN apt-get update && apt-get install -y \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

ARG APP_UID=1000
ARG APP_GID=1000
RUN groupadd --system --gid ${APP_GID} app && \
    useradd --system --uid ${APP_UID} --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app && \
    install -d -m 700 -o app -g app /home/app/.s3browser

USER app
WORKDIR /home/app

EXPOSE 8170

VOLUME ["/home/app/.s3browser"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["s3browser", "server", "--bind", ":8170"]

# Runtime stage for pre-built binary (used by CI to avoid double build)
FROM runtime-base AS runtime-prebuilt

# Binary must be passed via build context
COPY s3browser /usr/local/bin/s3browser

# Runtime stage - minimal image for container deployment (builds from source)
FROM runtime-base AS runtime

COPY --from=builder /s3browser /usr/local/bin/s3browser
