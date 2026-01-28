# Build stage
FROM node:24-alpine AS builder
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY . .

# Build frontend and server
RUN npm run build

# Production stage
FROM node:24-alpine AS runner
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built frontend from builder
COPY --from=builder /app/dist ./dist

# Copy built server from builder
COPY --from=builder /app/dist-server ./dist-server

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start"]
