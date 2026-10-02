// ABOUTME: Хранит конфигурацию Next.js веб-приложения.
// ABOUTME: Настройки экземпляра передаются через окружение при запуске.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // AIDEV-NOTE: BRAI_WEB_STANDALONE_OUTPUT=0 отключает упаковку пакетов для локальных проверок.
  output: process.env.BRAI_WEB_STANDALONE_OUTPUT === "0" ? undefined : "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
};

export default nextConfig;
