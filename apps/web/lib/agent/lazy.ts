// ABOUTME: Ограничивает кеш и параллельные чтения раскрываемых действий выбранного чата.
// ABOUTME: Поколение и revision входят в ключ; чтения не запускают и не повторяют ход.
import type { Command, DisplayItem } from "@brai/agent/contracts";
type Reply = { generation: string; data?: DisplayItem[]; item?: DisplayItem; nextCursor?: string | null };
type Context = { generation: string; epoch: string; projectId: string; threadId: string };
type Request = (command: Command & { action: "activities" | "item" }) => Promise<Reply>;

/** Читает summaries партиями до100 и detail по одному; максимум4 чтения и64 ожидающих. */
export function createLazyReads(request: Request) {
  const summaries = new Map<string, DisplayItem>(), details = new Map<string, DisplayItem>();
  const pending = new Map<string, Promise<DisplayItem[]>>();
  let running = 0;
  const queue: (() => void)[] = [];
  async function limited<T>(read: () => Promise<T>): Promise<T> {
    if (running >= 4) {
      if (queue.length >= 64) throw new Error("Слишком много открытых действий. Закройте часть и повторите.");
      await new Promise<void>(resolve => queue.push(resolve));
    } else running++;
    try { return await read(); }
    finally { const next = queue.shift(); if (next) next(); else running--; }
  }
  const key = (context: Context, item: DisplayItem) => JSON.stringify([context.generation, context.epoch, context.projectId, context.threadId, item.turnId, item.id, item.revision ?? 0]);
  const store = (cache: Map<string, DisplayItem>, id: string, item: DisplayItem, maximum: number) => {
    cache.delete(id); cache.set(id, item);
    while (cache.size > maximum) cache.delete(cache.keys().next().value!);
  };
  async function read(context: Context, items: DisplayItem[], full: boolean, refresh = false): Promise<DisplayItem[]> {
    const cache = full ? details : summaries, missing = items.filter(item => refresh || !cache.has(key(context, item)));
    const result = new Map(items.filter(item => !refresh && cache.has(key(context, item))).map(item => [item.id, cache.get(key(context, item))!]));
    for (let offset = 0; offset < missing.length; offset += full ? 1 : 100) {
      const batch = missing.slice(offset, offset + (full ? 1 : 100));
      // AIDEV-NOTE: Между сообщениями могут идти действия разных ходов; owner принимает только один turnId.
      const turns = [...new Set(batch.map(item => item.turnId))];
      for (const turnId of turns) {
        const part = batch.filter(item => item.turnId === turnId), token = JSON.stringify([full, ...part.map(item => key(context, item))]);
        let promise = pending.get(token);
        if (!promise) {
          promise = limited(async () => {
            let reply = await request({ action: full ? "item" : "activities", projectId: context.projectId, threadId: context.threadId, turnId, ...(full ? { itemId: part[0].id } : { itemIds: part.map(item => item.id) }) });
            if (reply.generation !== context.generation) throw new Error("Чат обновился. Повторите чтение.");
            const values = full ? reply.item ? [reply.item] : [] : reply.data ?? [];
            if (values.length !== part.length || part.some(item => !values.some(value => value.id === item.id && value.turnId === item.turnId && value.type === item.type))) throw new Error("Некорректный ответ. Повторите чтение.");
            if (full && values[0] && ["userMessage", "agentMessage"].includes(values[0].type)) {
              const chunks = [values[0].text], seen = new Set<string>();
              while (reply.nextCursor) {
                const cursor = reply.nextCursor;
                if (seen.has(cursor)) throw new Error("Некорректное продолжение сообщения.");
                seen.add(cursor);
                reply = await request({ action: "item", projectId: context.projectId, threadId: context.threadId, turnId, itemId: part[0].id, cursor });
                if (reply.generation !== context.generation) throw new Error("Чат обновился. Повторите чтение.");
                if (!reply.item || reply.item.id !== values[0].id || reply.item.turnId !== turnId || reply.item.type !== values[0].type || reply.item.revision !== values[0].revision) throw new Error("Сообщение обновилось. Повторите чтение.");
                chunks.push(reply.item.text);
              }
              if (reply.item?.truncated) throw new Error("Не удалось загрузить полное сообщение.");
              values[0] = { ...values[0], text: chunks.join(""), truncated: false };
            }
            for (const item of part) {
              const value = values.find(value => value.id === item.id)!;
              store(cache, key(context, { ...item, revision: value.revision ?? item.revision }), value, full ? 16 : 256);
            }
            return values;
          });
          pending.set(token, promise);
          void promise.finally(() => pending.delete(token)).catch(() => {});
        }
        for (const value of await promise) result.set(value.id, value);
      }
    }
    return items.map(item => result.get(item.id)!);
  }
  return {
    summaries: (context: Context, items: DisplayItem[]) => read(context, items, false),
    detail: async (context: Context, item: DisplayItem, refresh = false) => (await read(context, [item], true, refresh))[0],
  };
}
export type LazyReads = ReturnType<typeof createLazyReads>;
