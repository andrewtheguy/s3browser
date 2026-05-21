FROM oven/bun:1.3-alpine AS frontend-builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html components.json postcss.config.js tailwind.config.js tsconfig*.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN bun run build:client

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS runner

WORKDIR /app

COPY pyproject.toml README.md ./
COPY s3browser ./s3browser
COPY --from=frontend-builder /app/dist ./dist

RUN uv tool install .

ENV PATH="/root/.local/bin:${PATH}"

EXPOSE 8170

CMD ["s3browser", "server", "--bind", ":8170"]
