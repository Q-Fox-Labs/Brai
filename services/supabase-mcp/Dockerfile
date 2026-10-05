# ABOUTME: Собирает переносимый MCP из workspace без файлов admin.
# ABOUTME: Конфигурацию и пароль контейнер получает только при запуске.
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/agent/package.json services/agent/package.json
COPY services/artifacts/package.json services/artifacts/package.json
COPY services/auth/package.json services/auth/package.json
COPY services/supabase-mcp/package.json services/supabase-mcp/package.json
COPY services/timer/package.json services/timer/package.json
RUN npm ci --workspace=@brai/supabase-mcp --include-workspace-root=false --ignore-scripts
COPY services/supabase-mcp services/supabase-mcp
RUN npm run build --workspace=@brai/supabase-mcp

FROM node:24.21.0-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/services/agent/package.json services/agent/package.json
COPY --from=build /app/services/artifacts/package.json services/artifacts/package.json
COPY --from=build /app/services/auth/package.json services/auth/package.json
COPY --from=build /app/services/supabase-mcp/package.json services/supabase-mcp/package.json
COPY --from=build /app/services/timer/package.json services/timer/package.json
RUN npm ci --workspace=@brai/supabase-mcp --include-workspace-root=false --omit=dev --ignore-scripts
COPY --from=build /app/services/supabase-mcp/dist services/supabase-mcp/dist
COPY --from=build /app/services/supabase-mcp/LICENSE.supabase /app/services/supabase-mcp/NOTICE services/supabase-mcp/
USER node
CMD ["node", "services/supabase-mcp/dist/main.js"]
