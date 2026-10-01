# ABOUTME: Собирает переносимый MCP из workspace без файлов admin.
# ABOUTME: Конфигурацию и пароль контейнер получает только при запуске.
FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/supabase-mcp/package.json services/supabase-mcp/package.json
RUN npm ci --workspace=@brai/supabase-mcp --include-workspace-root=false --ignore-scripts
COPY services/supabase-mcp services/supabase-mcp
RUN npm run build --workspace=@brai/supabase-mcp

FROM node:24.21.0-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/services/supabase-mcp/package.json services/supabase-mcp/package.json
RUN npm ci --workspace=@brai/supabase-mcp --include-workspace-root=false --omit=dev --ignore-scripts
COPY --from=build /app/services/supabase-mcp/dist services/supabase-mcp/dist
COPY --from=build /app/services/supabase-mcp/LICENSE.supabase /app/services/supabase-mcp/NOTICE services/supabase-mcp/
USER node
CMD ["node", "services/supabase-mcp/dist/main.js"]
