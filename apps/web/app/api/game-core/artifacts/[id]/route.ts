// ABOUTME: Выдаёт файл ресурса через проверенную пользовательскую сессию.
// ABOUTME: Artifact ID не является полномочием; server проверяет связь с ресурсом и владельца.
import { requireSession } from "@/server/auth";
import { readElementArtifact } from "@/server/game-core";
import { failure } from "@/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Не открывает внутренний адрес Artifacts в браузере. */
export async function GET(request: Request, context: {params: Promise<{id:string}>}) {
 try { const session=await requireSession(request);return await readElementArtifact(session.user.id,(await context.params).id,request.signal); }
 catch(error) {return failure(error);}
}
