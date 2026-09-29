// ABOUTME: Хранит конфигурацию Next.js веб-приложения.
// ABOUTME: Настройки экземпляра передаются через окружение при запуске.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
};

export default nextConfig;
