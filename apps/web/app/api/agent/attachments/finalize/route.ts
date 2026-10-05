// ABOUTME: Проверяет готовность оригинала и копии и связывает их в artifacts.
// ABOUTME: Повторяет только идемпотентное отношение с тем же requestId.
import { finalizeAttachment } from "@/server/artifacts-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = finalizeAttachment;
