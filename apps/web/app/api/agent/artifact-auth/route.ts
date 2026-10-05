// ABOUTME: Авторизует закрытый Caddy file route по текущей сессии.
// ABOUTME: Успешный ответ содержит только safe headers для GET или HEAD.
import { artifactReadAuth } from "@/server/artifacts-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = artifactReadAuth;
export const HEAD = artifactReadAuth;
