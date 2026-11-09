// ABOUTME: Читает запись Дневника по UUID и страницу материалов.
// ABOUTME: Обсуждения и редактирование не поддерживаются.
import { diaryRead } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = diaryRead;
