# ============================================================
# Med-SEAL AI Service — Multi-stage Docker Build
# ============================================================

# ---------- Stage 1: Build ----------
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------- Stage 2: Production ----------
FROM node:20-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Create non-root user for security
RUN addgroup -S medseal && adduser -S medseal -G medseal

# Create data directory for audit log
RUN mkdir -p /data && chown medseal:medseal /data

USER medseal

EXPOSE 4003

CMD ["node", "dist/index.js"]
