# ABOUTME: Собирает и запускает сервис таймера на закреплённой Node.js LTS.
# ABOUTME: Контейнер содержит только production файлы сервиса.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
RUN npm ci
COPY services/timer services/timer
RUN npm run build --workspace=@brai/timer

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/services/timer/package.json services/timer/package.json
COPY --from=build /app/services/timer/dist services/timer/dist
CMD ["node", "services/timer/dist/main.js"]
