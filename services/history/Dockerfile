# ABOUTME: Запускает переносимый runtime-артефакт service_history на закреплённой Node.js LTS.
# ABOUTME: Сборка образа только копирует готовые файлы и не устанавливает пакеты.
FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=1000:1000 . .
USER 1000:1000
EXPOSE 3006
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/main.js"]
