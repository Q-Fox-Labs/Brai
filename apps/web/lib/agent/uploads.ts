// ABOUTME: Загружает исходный файл и подготовленную копию в artifacts по HTTP.
// ABOUTME: Стабильные requestId позволяют сверить готовый объект после потери ответа.
import type { Attachment } from "./images";
import type { ReferenceAttachment } from "../../../../services/artifacts/contracts/index.mjs";

type UploadScope = { userId: string; projectId: string; threadId: string };
type PreparedReply = { artifact?: { artifactId?: string; status?: string }; uploadUrl?: string; code?: string };
type ReadyPair = ReferenceAttachment & { url: string };
type UploadFileInput = { requestId: string; kind: "original" | "copy"; filename: string; file: Blob };
const mimeExt: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

async function jsonResponse(response: Response): Promise<PreparedReply> {
  try { return await response.json() as PreparedReply; } catch { return {}; }
}

async function prepare(scope: UploadScope, requestId: string, kind: "original" | "copy", filename: string, file: Blob, signal: AbortSignal, fetcher: typeof fetch): Promise<{ id: string; status: string; uploadUrl: string }> {
  const response = await fetcher("/api/agent/attachments/prepare", {
    method: "POST", cache: "no-store", signal,
    headers: { "X-Brai-User": scope.userId, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: scope.projectId, threadId: scope.threadId, requestId, kind, filename, mimeType: file.type }),
  });
  const value = await jsonResponse(response);
  if (!response.ok || !value.artifact?.artifactId || !value.artifact.status || !value.uploadUrl) {
    if (response.status === 401) throw new Error("Сеанс или аккаунт изменился. Войдите снова; изображение сохранено в черновике.");
    if (response.status === 403) throw new Error("У этого аккаунта нет доступа к Агенту.");
    if (response.status === 404) throw new Error("Чат больше недоступен. Выберите другой чат; изображение сохранено в черновике.");
    throw new Error(value.code === "UNAVAILABLE" ? "Хранилище изображений временно недоступно. Повторите отправку." : "Не удалось подготовить изображение. Черновик сохранён; повторите отправку.");
  }
  return { id: value.artifact.artifactId, status: value.artifact.status, uploadUrl: value.uploadUrl };
}

async function uploadOne(scope: UploadScope, input: UploadFileInput, signal: AbortSignal, fetcher: typeof fetch): Promise<string> {
  let prepared: { id: string; status: string; uploadUrl: string };
  prepared = await prepare(scope, input.requestId, input.kind, input.filename, input.file, signal, fetcher);
  if (prepared.status !== "ready") {
    if (prepared.status !== "pending") throw new Error(`Загрузка «${input.filename}» недоступна (${prepared.status}). Удалите это вложение и добавьте файл снова.`);
    let upload: Response | undefined;
    try {
      const target = new URL(prepared.uploadUrl, location.href);
      if (target.origin !== location.origin || !/^\/upload\/[A-Za-z0-9_-]{16,512}$/.test(target.pathname) || target.search || target.hash) throw new Error("BAD_UPLOAD_URL");
      upload = await fetcher(target.toString(), { method: "PUT", body: input.file, signal, cache: "no-store", credentials: "omit", redirect: "error", headers: { "Content-Type": input.file.type } });
    } catch (error) {
      if (signal.aborted) throw new Error("Загрузка отменена после смены чата или аккаунта. Черновик сохранён.");
      if (error instanceof Error && error.message === "BAD_UPLOAD_URL") throw new Error("Сервис вернул недопустимый адрес загрузки. Повторите попытку позже.");
    }
    if (upload?.status === 201) {
      const id = upload.headers.get("X-Artifact-Id"), state = upload.headers.get("X-Artifact-State"), size = upload.headers.get("X-Artifact-Size"), digest = upload.headers.get("X-Artifact-SHA256"), location = upload.headers.get("Location");
      if (id === prepared.id && state === "ready" && size === String(input.file.size) && digest && /^[0-9a-f]{64}$/.test(digest) && location) return prepared.id;
      prepared = await prepare(scope, input.requestId, input.kind, input.filename, input.file, signal, fetcher);
      if (prepared.status !== "ready") throw new Error(`Хранилище не подтвердило «${input.filename}». Файл сохранён в черновике; повторите отправку.`);
      return prepared.id;
    }
    if (upload && upload.status !== 409) throw new Error(`Не удалось загрузить «${input.filename}» (HTTP ${upload.status}). Файл и текст сохранены; повторите отправку.`);
    if (signal.aborted) throw new Error("Загрузка отменена после смены чата или аккаунта. Черновик сохранён.");
    prepared = await prepare(scope, input.requestId, input.kind, input.filename, input.file, signal, fetcher);
    if (prepared.status !== "ready") throw new Error(`Загрузка «${input.filename}» не подтверждена. Файл сохранён в черновике; повторите отправку.`);
  }
  return prepared.id;
}

function thumbnailUrl(scope: UploadScope, pair: { originalArtifactId: string; modelArtifactId: string }): string {
  const query = new URLSearchParams({ projectId: scope.projectId, threadId: scope.threadId, expectedUserId: scope.userId });
  return `/api/agent/attachments/${pair.modelArtifactId}?${query}`;
}

/** Загружает image pair, повторно сверяет uncertain PUT и ждёт relation до вызова Agent. */
export async function uploadAttachment(image: Attachment, scope: UploadScope, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ReadyPair> {
  const originalArtifactId = await uploadOne(scope, {
    requestId: image.originalRequestId, kind: "original", filename: image.name, file: image.original,
  }, signal, fetcher);
  const modelArtifactId = image.reduced
    ? await uploadOne(scope, {
      requestId: image.modelRequestId!, kind: "copy", filename: modelFilename(image.name, image.model.type), file: image.model,
    }, signal, fetcher)
    : originalArtifactId;
  const response = await fetcher("/api/agent/attachments/finalize", {
    method: "POST", cache: "no-store", signal,
    headers: { "X-Brai-User": scope.userId, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: scope.projectId, threadId: scope.threadId, requestId: image.relationRequestId, originalArtifactId, modelArtifactId }),
  });
  await jsonResponse(response);
  if (!response.ok) {
    if (response.status === 409) throw new Error("Загрузка ещё не подтверждена. Черновик сохранён; повторите отправку.");
    throw new Error("Не удалось связать копию изображения с оригиналом. Черновик сохранён; повторите отправку.");
  }
  return { originalArtifactId, modelArtifactId, url: thumbnailUrl(scope, { originalArtifactId, modelArtifactId }) };
}

/** Возвращает безопасное имя копии, сохраняя исходное расширение для оригинала отдельно. */
export function modelFilename(name: string, mimeType: string): string {
  const ext = mimeExt[mimeType];
  const base = name.replace(/\.[^.]*$/, "");
  return `${base}-model.${ext ?? "img"}`;
}
