// ABOUTME: Выдаёт сохранённый оригинал материала Дневника.
// ABOUTME: Владелец и связь с записью проверяются перед каждым чтением.
import { diaryFile } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = diaryFile;
export const HEAD = diaryFile;
