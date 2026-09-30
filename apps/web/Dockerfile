# ABOUTME: Собирает и запускает веб-приложение на закреплённой Node.js LTS.
# ABOUTME: Контейнер использует production output Next.js standalone.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/timer/package.json services/timer/package.json
COPY services/auth/package.json services/auth/package.json
RUN npm ci
COPY apps/web apps/web
COPY services/timer/schemas services/timer/schemas
COPY services/auth/schemas services/auth/schemas
RUN npm run build --workspace=@brai/web

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/services/timer/schemas ./services/timer/schemas
COPY --from=build /app/services/auth/schemas ./services/auth/schemas
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
