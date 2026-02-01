# Build stage
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source files
COPY . .

# Build frontend and server
RUN bun run build

# Production stage
FROM oven/bun:1.3-alpine AS runner

RUN mkdir -p /home/bun/app && chown -R bun:bun /home/bun

WORKDIR /home/bun/app

# Copy package files
COPY --chown=bun:bun package.json bun.lock ./

# Install production dependencies only
USER bun
RUN bun install --frozen-lockfile --production

# Copy built frontend from builder
COPY --from=builder --chown=bun:bun /app/dist ./dist

# Copy built server from builder
COPY --from=builder --chown=bun:bun /app/dist-server ./dist-server

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "start"]
