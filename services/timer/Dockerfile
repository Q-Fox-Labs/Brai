# ABOUTME: Собирает и запускает сервис таймера на закреплённой Node.js LTS.
# ABOUTME: Контейнер содержит только production файлы сервиса.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
RUN npm ci
COPY services/timer services/timer
RUN npm run build --workspace=@brai/timer

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
RUN npm ci --omit=dev --workspace=@brai/timer
WORKDIR /app/services/timer
COPY --from=build /app/services/timer/package.json ./package.json
COPY --from=build /app/services/timer/dist ./dist
COPY --from=build /app/services/timer/schemas ./schemas
COPY --from=build /app/services/timer/migrations ./migrations
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]
