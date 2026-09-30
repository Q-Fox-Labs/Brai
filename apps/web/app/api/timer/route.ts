// ABOUTME: Возвращает согласованный снимок владельца состояния таймера.
// ABOUTME: Ответ не кешируется и не читает БД напрямую.
import { snapshot } from "@/server/gateway";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Запрашивает snapshot NATS Services. */
export async function GET() { try { return Response.json(await snapshot()); } catch (error) { return failure(error); } }
