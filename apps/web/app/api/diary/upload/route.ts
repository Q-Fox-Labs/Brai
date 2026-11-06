// ABOUTME: Передаёт оригинал материала Дневника в Artifacts.
// ABOUTME: Успех означает проверенные размер, контрольную сумму и готовность файла.
import { diaryUpload } from "@/server/diary-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = diaryUpload;
