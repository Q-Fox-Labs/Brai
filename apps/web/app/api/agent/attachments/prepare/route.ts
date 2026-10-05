// ABOUTME: Открывает или восстанавливает одну HTTP загрузку артефакта.
// ABOUTME: Ответ содержит только DTO artifacts и проверенную bearer upload URL.
import { prepareAttachment } from "@/server/artifacts-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = prepareAttachment;
