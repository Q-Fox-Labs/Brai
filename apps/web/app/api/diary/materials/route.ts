// ABOUTME: Готовит загрузку оригинального материала Дневника.
// ABOUTME: Файл связывается только с сохранённой записью текущего владельца.
import { diaryPrepare } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = diaryPrepare;
