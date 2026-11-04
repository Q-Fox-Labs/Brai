// ABOUTME: Сохраняет неизменяемые записи и материалы Дневника через порт Artifacts.
// ABOUTME: Проверяет владельца и источник; не запускает модели и не удаляет данные.
import { createHash } from "node:crypto";
import type { Artifact } from "../../../services/artifacts/contracts/index.mjs";
import type { DiaryEntry, DiaryMaterial, DiarySummary } from "../app/diary/types";

export class DiaryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type Prepared = { artifact: Artifact; uploadUrl: string };
export type ArtifactPage = { items: Artifact[]; total: number };
export type DiaryPorts = {
  call<T>(operation: "prepare" | "get" | "list", input: unknown): Promise<T>;
  put(prepared: Prepared, bytes: Uint8Array): Promise<void>;
  read(artifact: Artifact, maxBytes: number): Promise<Uint8Array>;
};
const bad = () => new DiaryError(400, "INVALID_ARGUMENT");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Принимает только UUID, не разрешая произвольные пути и subjects. */
export function diaryId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw bad();
  return value.toLowerCase();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\u0000") || !value.isWellFormed()) throw bad();
  return value;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw bad();
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0,4)) < 1 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw bad();
  return value;
}
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function summary(item: Artifact): DiarySummary {
  return { id: item.artifactId, title: item.title, date: typeof item.details?.date === "string" ? item.details.date : null, createdAt: item.createdAt };
}
/** Ограничивает внешнее представление metadata без внутреннего URL. */
export function diaryMaterial(item: Artifact): DiaryMaterial {
  return { id:item.artifactId, filename:item.filename, mimeType:item.mimeType, sizeBytes:item.sizeBytes, sha256:item.sha256, status:item.status, role:typeof item.details?.role === "string" ? item.details.role : "original" };
}
/** Собирает операции Дневника; вся долговечность принадлежит порту Artifacts. */
export function createDiary(ports: DiaryPorts) {
  async function owned(owner: string, id: string, source: string, ready = true): Promise<Artifact> {
    const item = await ports.call<Artifact>("get", { artifactId: diaryId(id) });
    if (item.ownerId !== owner || item.source !== source || item.kind !== "original") throw new DiaryError(404,"NOT_FOUND");
    if (ready && item.status !== "ready") throw new DiaryError(409,"NOT_READY");
    return item;
  }
  async function listSource(owner: string, source: string, offset = 0): Promise<ArtifactPage> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw bad();
    const page = await ports.call<ArtifactPage>("list", { filter:{ownerId:owner,kind:"original",source,status:"ready"},sort:"createdAt",order:"desc",limit:50,offset });
    if (page.items.some(item=>item.ownerId !== owner || item.source !== source || item.status !== "ready" || item.kind !== "original")) throw new DiaryError(502,"BAD_REPLY");
    return page;
  }
  async function create(owner: string, value: unknown): Promise<DiarySummary> {
    const input = object(value); exact(input,["requestId","title","date","text"]);
    const requestId = diaryId(input.requestId), title = text(input.title,512), entryDate = date(input.date), body = text(input.text,8*1024*1024,true);
    // AIDEV-NOTE: Пробелы и переводы строк сохраняются; хеш связывает повтор с точными байтами.
    const bytes = Buffer.from(JSON.stringify({version:1,title,date:entryDate,text:body}));
    if (bytes.length > 16*1024*1024) throw new DiaryError(413,"TOO_LARGE");
    const prepared = await ports.call<Prepared>("prepare", {requestId:"diary:entry:"+requestId,ownerId:owner,kind:"original",metadata:{title,filename:"diary-entry.json",extension:"json",mimeType:"application/json",source:"diary",details:{schemaVersion:1,date:entryDate,sha256:sha(bytes)}}});
    const item = prepared.artifact;
    if (item.ownerId !== owner || item.source !== "diary" || item.kind !== "original" || item.details?.sha256 !== sha(bytes)) throw new DiaryError(409,"CONFLICT");
    if (item.status !== "ready") await ports.put(prepared,bytes);
    const saved = await owned(owner,item.artifactId,"diary");
    if (saved.sha256 !== sha(bytes) || saved.sizeBytes !== bytes.length) throw new DiaryError(502,"INTEGRITY");
    return summary(saved);
  }
  async function get(owner: string, id: string, offset = 0): Promise<DiaryEntry> {
    const item = await owned(owner,id,"diary");
    const bytes = await ports.read(item,16*1024*1024);
    if (bytes.length !== item.sizeBytes || sha(bytes) !== item.sha256 || item.details?.sha256 !== item.sha256) throw new DiaryError(502,"INTEGRITY");
    let document;
    try { document = object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))); }
    catch { throw new DiaryError(502,"BAD_REPLY"); }
    if (document.version !== 1 || typeof document.text !== "string" || document.title !== item.title || document.date !== (item.details?.date ?? null)) throw new DiaryError(502,"BAD_REPLY");
    const page = await listSource(owner,"diary:"+item.artifactId,offset);
    return {...summary(item),text:document.text,materials:page.items.map(diaryMaterial),materialsTotal:page.total};
  }
  async function prepareMaterial(owner: string, id: string, value: unknown): Promise<Prepared> {
    const entry = await owned(owner,id,"diary"), input = object(value);
    exact(input,["requestId","filename","mimeType","role"]);
    const requestId = diaryId(input.requestId), filename = text(input.filename,1024), mimeType = text(input.mimeType,255);
    if (/[\r\n/\\]/.test(filename) || /[\r\n]/.test(mimeType) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType)) throw bad();
    if (!["original","transcript","correction"].includes(String(input.role))) throw bad();
    const ext = filename.includes(".") ? filename.split(".").at(-1)! : "";
    const prepared = await ports.call<Prepared>("prepare",{requestId:"diary:material:"+requestId,ownerId:owner,kind:"original",metadata:{title:filename,filename,extension:/^[a-zA-Z0-9._-]{0,32}$/.test(ext)?ext:"",mimeType,source:"diary:"+entry.artifactId,details:{role:input.role}}});
    if (prepared.artifact.ownerId !== owner || prepared.artifact.source !== "diary:"+entry.artifactId || prepared.artifact.kind !== "original") throw new DiaryError(409,"CONFLICT");
    return prepared;
  }
  async function material(owner: string, entryId: string, id: string, ready = true) {
    await owned(owner,entryId,"diary");
    return owned(owner,id,"diary:"+diaryId(entryId),ready);
  }
  return {create,get,prepareMaterial,material,
    async list(owner:string,offset=0) {const page=await listSource(owner,"diary",offset);return {entries:page.items.map(summary),total:page.total};},
  };
}
