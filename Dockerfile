# Build stage
FROM oven/bun:alpine AS builder
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
FROM oven/bun:alpine AS runner

RUN addgroup -g 1000 s3browser && \
    adduser -D -u 1000 -G s3browser s3browser

WORKDIR /app

# Copy package files
COPY --chown=s3browser:s3browser package.json bun.lock ./

# Install production dependencies only
USER s3browser
RUN bun install --frozen-lockfile --production

# Copy built frontend from builder
COPY --from=builder --chown=s3browser:s3browser /app/dist ./dist

# Copy built server from builder
COPY --from=builder --chown=s3browser:s3browser /app/dist-server ./dist-server

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "start"]
