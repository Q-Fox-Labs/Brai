// ABOUTME: Продолжает загрузку аудио с подтверждённой сервером границы.
// ABOUTME: Проверяет сохранённый префикс частями; целый файл в память не загружает.
export type UploadState = {offset: number; totalBytes: number | null; chain: string; chunkBytes: number; ready: boolean};
type Ports = {
  read: () => Promise<UploadState>;
  send: (part: Blob, offset: number, chain: string) => Promise<void>;
  progress: (loaded: number, total: number) => void;
  waiting: () => void;
  signal: AbortSignal;
};
const emptyChain = "0".repeat(64);
const fail = (text: string) => Object.assign(new Error(text), {status: 400});
/** Считает цепочку SHA-256 по частям без зависимости от транспорта. */
export async function nextChain(previous: string, part: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await part.arrayBuffer()));
  const input = new Uint8Array(64);
  for (let i = 0; i < 32; i++) input[i] = parseInt(previous.slice(i * 2, i * 2 + 2), 16);
  input.set(digest, 32);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)), n => n.toString(16).padStart(2, "0")).join("");
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new DOMException("Остановлено", "AbortError"));};
    const timer = setTimeout(() => {signal.removeEventListener("abort", stop); resolve();}, ms);
    signal.addEventListener("abort", stop, {once: true}); if (signal.aborted) stop();
  });
}
/** При разрыве сначала сверяет сервер, затем повторяет только непринятую часть; после 6 сбоев сохраняет возможность ручного продолжения. */
export async function resumeUpload(file: File, ports: Ports): Promise<void> {
  const chains = new Map<number, string>([[0, emptyChain]]);
  let failures = 0;
  for (;;) {
    ports.signal.throwIfAborted();
    try {
      const state = await ports.read();
      if (state.totalBytes !== null && state.totalBytes !== file.size) throw fail("Размер отличается. Выберите исходный файл.");
      if (state.chunkBytes !== 1048576 || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > file.size
        || (!state.ready && state.offset % state.chunkBytes !== 0) || !/^[0-9a-f]{64}$/.test(state.chain)) throw fail("Не удалось проверить сохранённую часть файла.");
      if (!state.ready && state.offset === file.size) throw fail("Сервер ещё не подтвердил сохранение файла. Выберите его снова позже.");
      // AIDEV-NOTE: Имя/mtime не доказывают равенство содержимого. Сверяем все уже принятые байты локально.
      for (let offset = 0; offset < state.offset; offset += state.chunkBytes) {
        ports.signal.throwIfAborted();
        const end = Math.min(state.offset, offset + state.chunkBytes);
        if (!chains.has(end)) chains.set(end, await nextChain(chains.get(offset)!, file.slice(offset, end)));
      }
      const chain = chains.get(state.offset)!;
      if (state.chain !== chain) throw fail("Сохранённая часть отличается. Выберите исходный файл.");
      ports.progress(state.offset, file.size);
      if (state.ready) return;
      const end = Math.min(file.size, state.offset + state.chunkBytes), part = file.slice(state.offset, end);
      const next = await nextChain(chain, part);
      await ports.send(part, state.offset, chain);
      chains.set(end, next); failures = 0;
    } catch (error) {
      const status = (error as {status?: number}).status;
      if (ports.signal.aborted || (error as Error).name === "AbortError") throw error;
      if (status && status < 500 && ![409, 429].includes(status)) throw error;
      if (++failures > 6) throw new Error("Связь не восстановилась. Сохранённые части остаются на сервере. Выберите тот же файл, чтобы продолжить.");
      ports.waiting(); await delay(Math.min(500 * 2 ** (failures - 1), 8000), ports.signal);
    }
  }
}
/** Форматирует фактические байты в десятичные единицы, совпадающие с размером файла в загрузке. */
export function uploadBytes(bytes: number): string {
  if (bytes < 1000) return bytes.toLocaleString("ru-RU") + " Б";
  const unit = bytes >= 1e9 ? 1e9 : bytes >= 1e6 ? 1e6 : 1e3;
  return (bytes / unit).toLocaleString("ru-RU", {maximumFractionDigits: 1}) + (unit === 1e9 ? " ГБ" : unit === 1e6 ? " МБ" : " КБ");
}
