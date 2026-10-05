# ABOUTME: Собирает официальный Better Auth и автономный NATS adapter.
# ABOUTME: Runtime не содержит внутренних материалов admin и не слушает HTTP.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
COPY services/agent/package.json services/agent/package.json
COPY services/artifacts/package.json services/artifacts/package.json
COPY services/history/package.json services/history/package.json
COPY services/supabase-mcp/package.json services/supabase-mcp/package.json
RUN npm ci
COPY services/auth services/auth
RUN npm run build --workspace=@brai/auth
FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
COPY services/agent/package.json services/agent/package.json
COPY services/artifacts/package.json services/artifacts/package.json
COPY services/history/package.json services/history/package.json
COPY services/supabase-mcp/package.json services/supabase-mcp/package.json
RUN npm ci --omit=dev --workspace=@brai/auth
WORKDIR /app/services/auth
COPY --from=build /app/services/auth/dist ./dist
COPY --from=build /app/services/auth/schemas ./schemas
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]
