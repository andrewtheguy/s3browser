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
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy built frontend from builder
COPY --from=builder /app/dist ./dist

# Copy built server from builder
COPY --from=builder /app/dist-server ./dist-server

ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "start"]
