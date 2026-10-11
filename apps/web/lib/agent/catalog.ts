// ABOUTME: Обновляет каталог при видимой вкладке и перечитывает загруженный диапазон чатов.
// ABOUTME: Не открывает чаты и не хранит историю; полная выборка нужна для точного счётчика.
import type { ThreadMetadata } from "@brai/agent/contracts";
type Page = { generation: string; data: ThreadMetadata[]; nextCursor: string | null };

/** Читает все страницы атомарно; ошибка или смена поколения сохраняет прежний каталог UI. */
export async function readAllThreads(read: (cursor?: string) => Promise<Page>): Promise<Page> {
  const data = new Map<string, ThreadMetadata>(), seen = new Set<string>();
  let cursor: string | undefined, generation: string | undefined;
  for (;;) {
    const page = await read(cursor);
    if (generation && generation !== page.generation) throw new Error("Каталог обновился. Повторите чтение.");
    generation = page.generation;
    for (const thread of page.data) data.set(thread.id, thread);
    if (!page.nextCursor) return { generation, data: [...data.values()], nextCursor: null };
    if (seen.has(page.nextCursor)) throw new Error("Некорректное продолжение каталога.");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}

/** Читает прежний объём с начала; одна страница обязательна, cursor и поколение проверяются. */
export async function readThreadRange(read: (cursor?: string) => Promise<Page>, count: number): Promise<Page> {
  const data = new Map<string, ThreadMetadata>(), seen = new Set<string>();
  let page: Page, cursor: string | undefined, generation: string | undefined;
  do {
    page = await read(cursor);
    if (generation && generation !== page.generation) throw new Error("Каталог обновился. Повторите чтение.");
    generation = page.generation;
    for (const thread of page.data) data.set(thread.id, thread);
    if (!page.nextCursor || data.size >= Math.min(1000, Math.max(1, count))) break;
    if (seen.has(page.nextCursor) || seen.size >= 1000) throw new Error("Некорректное продолжение каталога.");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  } while (true);
  return { generation, data: [...data.values()].slice(0, 1000), nextCursor: data.size >= 1000 ? null : page.nextCursor };
}

/** Опрос каждые 10 секунд и при возврате вкладки; один refresh, ошибки сохраняет вызывающий UI. */
export function startCatalogPolling(refresh: () => Promise<void>, isActive: () => boolean, visibility: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document): () => void {
  let running = false, stopped = false;
  const poll = async () => {
    if (stopped || running || !isActive() || visibility.visibilityState !== "visible") return;
    running = true;
    try { await refresh(); } catch { /* UI сохраняет прежний каталог и показывает ошибку. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { void poll(); }, 10_000);
  const visible = () => { void poll(); };
  visibility.addEventListener("visibilitychange", visible);
  return () => { stopped = true; clearInterval(timer); visibility.removeEventListener("visibilitychange", visible); };
}
