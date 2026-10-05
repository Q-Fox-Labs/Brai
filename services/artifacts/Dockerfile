# ABOUTME: Собирает и запускает PostgreSQL/NATS сервис artifacts.
# ABOUTME: Runtime не содержит owner migration inputs и не выполняет DDL.
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
COPY services/artifacts services/artifacts
RUN npm run build --workspace=@brai/artifacts

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
RUN npm ci --omit=dev --workspace=@brai/artifacts
WORKDIR /app/services/artifacts
COPY --from=build /app/services/artifacts/package.json ./package.json
COPY --from=build /app/services/artifacts/dist ./dist
COPY --from=build /app/services/artifacts/contracts ./contracts
COPY --from=build /app/services/artifacts/schemas ./schemas
COPY --from=build /app/services/artifacts/migrations ./migrations
ENV ARTIFACTS_DATA_DIR=/var/lib/brai-artifacts
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]
