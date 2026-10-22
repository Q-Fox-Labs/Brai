# ABOUTME: Запускает готовую переносимую поставку alerts без установки пакетов.
# ABOUTME: Контекст собирает package-runtime.mjs; runtime не применяет SQL миграции.
FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node . .
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]
