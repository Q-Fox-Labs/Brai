# ABOUTME: Собирает и запускает веб-приложение на закреплённой Node.js LTS.
# ABOUTME: Контейнер использует production output Next.js standalone.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
COPY services/agent/package.json services/agent/package.json
COPY services/artifacts/package.json services/artifacts/package.json
COPY services/history/package.json services/history/package.json
COPY services/alerts/package.json services/alerts/package.json
COPY services/local-ai/package.json services/local-ai/package.json
COPY services/supabase-mcp/package.json services/supabase-mcp/package.json
RUN npm ci
COPY apps/web apps/web
COPY services/timer/schemas services/timer/schemas
COPY services/auth/schemas services/auth/schemas
COPY services/history/schemas services/history/schemas
COPY services/agent/contracts/index.* services/agent/contracts/
COPY services/artifacts/contracts services/artifacts/contracts
COPY services/artifacts/schemas services/artifacts/schemas
COPY services/alerts/contracts services/alerts/contracts
COPY services/alerts/schemas services/alerts/schemas
RUN npm run build --workspace=@brai/web

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/services/timer/schemas ./services/timer/schemas
COPY --from=build /app/services/auth/schemas ./services/auth/schemas
COPY --from=build /app/services/agent/package.json ./services/agent/package.json
COPY --from=build /app/services/agent/contracts ./services/agent/contracts
COPY --from=build /app/services/artifacts/package.json ./services/artifacts/package.json
COPY --from=build /app/services/artifacts/contracts ./services/artifacts/contracts
COPY --from=build /app/services/artifacts/schemas ./services/artifacts/schemas
COPY --from=build /app/services/alerts/contracts ./services/alerts/contracts
COPY --from=build /app/services/alerts/schemas ./services/alerts/schemas
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
