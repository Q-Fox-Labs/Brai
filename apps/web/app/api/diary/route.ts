// ABOUTME: Предоставляет список и создание записей Дневника.
// ABOUTME: Авторизация и проверка Origin принадлежат серверному обработчику.
import { diaryCollection } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = diaryCollection;
export const POST = diaryCollection;
