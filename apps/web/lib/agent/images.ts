// ABOUTME: Проверяет и готовит локальные изображения для закрытой команды agent.
// ABOUTME: Оригинал сохраняется в бюджете; уменьшение явно помечено и не создаёт нечитаемые миниатюры.
import { limits } from "@brai/agent/contracts";
import type { ModelCatalog, ModelChoice, NativeSnapshot } from "@brai/agent/contracts";

export type Attachment = { id: string; name: string; dataUrl: string; bytes: number; reduced: boolean };
export type ComposerDraft = { text: string; revision: number; images: Attachment[] };

/** Удаляет только принятые вложения; текст с правками после отправки сохраняется. */
export function acceptedDraft(current: ComposerDraft, sent: ComposerDraft): ComposerDraft {
  const ids = new Set(sent.images.map(image => image.id));
  return { ...current, text: current.revision === sent.revision ? "" : current.text, images: current.images.filter(image => !ids.has(image.id)) };
}

/** Активный ход использует только фактическую модель; каталог другого поколения непригоден. */
export function imageModel(catalog: ModelCatalog | null, view: NativeSnapshot | null, selected: ModelChoice | undefined, active: boolean): ModelChoice | undefined {
  if (!catalog || !view || catalog.generation !== view.generation) return undefined;
  return active ? catalog.data.find(choice => choice.model === view.thread.model) : selected;
}

/** Проверяет MIME и сигнатуру; неверный тип не исправляется скрытой перекодировкой. */
export function validateImageFile(type: string, size: number, data: Uint8Array): void {
  if (!["image/png", "image/jpeg", "image/webp"].includes(type)) throw new Error("Поддерживаются только PNG, JPEG и WebP. Выберите изображение одного из этих форматов.");
  if (!size || size > 20 * 1024 * 1024) throw new Error("Файл пуст или больше 20 МиБ. Выберите файл меньшего размера.");
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte);
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const webp = String.fromCharCode(...data.slice(0, 4)) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP";
  if (!(type === "image/png" ? png : type === "image/jpeg" ? jpeg : webp)) throw new Error("Содержимое файла не соответствует формату изображения. Выберите исправный PNG, JPEG или WebP.");
}

function dataUrl(data: Uint8Array, type: string): string {
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}

/** Готовит один файл до оставшегося decoded-бюджета (bytes), освобождает bitmap при любом исходе. */
export async function prepareImage(file: File, budget: number): Promise<Attachment> {
  // AIDEV-NOTE: Размер проверяется до чтения, чтобы очередь не удерживала произвольные буферы.
  validateImageFile(file.type, file.size, new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("Не удалось прочитать изображение. Файл повреждён или формат не поддерживается браузером."); }
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32_000_000) throw new Error("Изображение больше 32 миллионов пикселей. Уменьшите его перед добавлением.");
    const base = { id: crypto.randomUUID(), name: file.name || "Изображение" };
    if (file.size <= budget) return { ...base, dataUrl: dataUrl(new Uint8Array(await file.arrayBuffer()), file.type), bytes: file.size, reduced: false };
    // AIDEV-NOTE: Остаток в несколько байтов нельзя заполнять нечитаемой копией; старые вложения остаются.
    if (budget < 16 * 1024) throw new Error("Для читаемого изображения не хватает места в лимите 640 КиБ. Удалите одно из вложений.");
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) throw new Error("Браузер не смог подготовить изображение. Попробуйте другой файл.");
    const originalSide = Math.max(bitmap.width, bitmap.height), minimumSide = Math.min(512, originalSide);
    let side = Math.min(2048, originalSide);
    const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    while (true) {
      canvas.width = Math.max(1, Math.round(bitmap.width * side / originalSide));
      canvas.height = Math.max(1, Math.round(bitmap.height * side / originalSide));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.72, 0.58]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
        if (blob && blob.size <= budget && ["image/jpeg", "image/webp", "image/png"].includes(blob.type)) return { ...base, dataUrl: dataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type), bytes: blob.size, reduced: true };
      }
      if (side <= minimumSide) break;
      side = Math.max(minimumSide, Math.floor(side * 0.8));
    }
    throw new Error(`Изображение не помещается в общий лимит ${limits.imageBytes / 1024} КиБ без потери читаемости. Удалите вложение или подготовьте меньший файл.`);
  } finally { bitmap.close(); }
}
