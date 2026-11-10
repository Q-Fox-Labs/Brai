// ABOUTME: Принимает явный повтор расшифровки собственной записи Дневника.
// ABOUTME: Auth и Origin проверяет общий proxy; повтором владеет Diary.
import { diaryRetry } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = diaryRetry;
