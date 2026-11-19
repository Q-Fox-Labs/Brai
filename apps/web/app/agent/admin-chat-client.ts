// ABOUTME: Читает чаты разных профилей через существующие административные операции Web.
// ABOUTME: Сохраняет владельца в ключах и дочитывает пропущенные сообщения после разрыва связи.
export type ChatOwner = { id: string; name: string; profileId?: string | null; telegramId?: string | null };
export type TelegramProfile = { telegramId: string | null; name: string; username?: string | null; avatar?: string | null };
export type AdminChat = { id: string; title: string; updatedAt: string; owner: ChatOwner; participant?: TelegramProfile };
/** Имя именно аккаунта диалога, включая второй подключённый Telegram. */
export function chatParticipant(chat: AdminChat): string {
  const person = chat.participant;
  if (person?.name || person?.username) return [person.name, person.username ? "@" + person.username : ""].filter(Boolean).join(" · ");
  return person?.telegramId || chat.owner.name || chat.owner.telegramId || "Пользователь";
}
export type ChatAttachment = { artifactId: string; filename: string; mimeType: string; sizeBytes?: number };
export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string; authorName?: string; authorUsername?: string; attachments?: ChatAttachment[]; attachmentState?: string; messageType?: string; editedAt?: string | null; richMessage?: unknown; deleted?: boolean };
export type ChatPage = { source?: "telegram"; messages: ChatMessage[]; nextCursor: string | null; updatesCursor?: string };

/** Отказ HTTP; 401/403 прекращают просмотр и удаляют уже показанные данные. */
export class AdminChatError extends Error {
  status: number;
  constructor(status: number) { super("Не удалось прочитать переписку."); this.status = status; }
}
/** Составной ключ не смешивает одинаковые ID чатов разных пользователей. */
export function adminChatKey(chat: AdminChat): string { return JSON.stringify([chat.owner.id, chat.id]); }
/** Связывает ошибку источника только с выбранным профилем. */
export function selectedChatUnavailable(chat: AdminChat | null, owners: ChatOwner[]): boolean { return !!chat && owners.some(owner => owner.id === chat.owner.id); }
/** Выполняет только чтение; сессия проверяется сервером на каждом запросе. */
export async function chatQuery<T>(operation: string, input: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch("/api/admin?" + new URLSearchParams({ operation, ...input }), { cache: "no-store", signal });
  if (!response.ok) throw new AdminChatError(response.status);
  const value = await response.json() as T;
  if (input.source === "telegram" && (value as { source?: string }).source !== "telegram") throw new AdminChatError(503);
  return value;
}
type AdminChatList = { chats: AdminChat[]; unavailable: ChatOwner[] };

/** Публикует доступные чаты по мере чтения страниц и сохраняет их при сбое отдельного профиля. */
export async function loadAdminChats(previous: AdminChat[], signal: AbortSignal, onProgress?: (value: AdminChatList) => void): Promise<AdminChatList> {
  const { users } = await chatQuery<{ users: ChatOwner[] }>("users-list", {}, signal);
  const owners: ChatOwner[] = users.filter(user => user.profileId);
  const chats = new Map(owners.map(owner => [owner.id, previous.filter(chat => chat.owner.id === owner.id).map(chat => ({ ...chat, owner }))]));
  const unavailable: ChatOwner[] = [];
  const snapshot = () => ({
    chats: [...chats.values()].flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || adminChatKey(a).localeCompare(adminChatKey(b))),
    unavailable: [...unavailable],
  });
  let nextOwner = 0;
  // AIDEV-NOTE: Ограничиваем число одновременно создаваемых снимков на стороне Hermes.
  await Promise.all(owners.slice(0, 3).map(async () => {
    while (!signal.aborted && nextOwner < owners.length) {
      const owner = owners[nextOwner++];
      const cached = chats.get(owner.id) ?? [];
      const items = new Map<string, AdminChat>();
      try {
        let cursor: string | null = null;
        const visited = new Set<string>();
        do {
          const page: { items: Omit<AdminChat, "owner">[]; profiles?: TelegramProfile[]; nextCursor: string | null } = await chatQuery("admin-chats-list", { userId: owner.id, source: "telegram", ...(cursor ? { cursor } : {}) }, signal);
          for (const item of page.items) {
            if (items.has(item.id)) continue;
            const profile = page.profiles?.find(profile => profile.telegramId === item.participant?.telegramId);
            items.set(item.id, { ...item, owner, participant: profile ? { ...item.participant, ...profile, name: profile.name || item.participant?.name || "" } : item.participant });
          }
          cursor = page.nextCursor;
          chats.set(owner.id, cursor ? [...items.values(), ...cached.filter(item => !items.has(item.id))] : [...items.values()]);
          if (!signal.aborted) onProgress?.(snapshot());
          if (cursor && visited.has(cursor)) throw new AdminChatError(503);
          if (cursor) visited.add(cursor);
        } while (cursor);
      } catch (error) {
        if (signal.aborted || error instanceof AdminChatError && [401, 403].includes(error.status)) throw error;
        unavailable.push(owner);
        onProgress?.(snapshot());
      }
    }
  }));
  return snapshot();
}
/** Открывает свежую страницу либо продолжает к более ранним сообщениям того же чата. */
export async function readAdminChat(chat: AdminChat, signal: AbortSignal, cursor?: string): Promise<ChatPage> {
  let page: ChatPage;
  do {
    page = await chatQuery("admin-chats-get", { userId: chat.owner.id, chatId: chat.id, source: "telegram", order: "desc", ...(cursor ? { cursor } : {}) }, signal);
    cursor = page.nextCursor ?? undefined;
  } while (!page.messages.length && cursor);
  return page;
}
/** Дочитывает разрыв больше одной страницы, не перечитывая уже загруженную историю. */
export async function latestAdminChat(chat: AdminChat, lastId: string | undefined, signal: AbortSignal, updatesCursor?: string): Promise<ChatPage> {
  if (updatesCursor) {
    let cursor: string | null = updatesCursor, messages: ChatMessage[] = [], updated = updatesCursor;
    do {
      const page: ChatPage = await chatQuery("admin-chats-get", { userId: chat.owner.id, chatId: chat.id, source: "telegram", order: "desc", cursor }, signal);
      messages = mergeAdminMessages(messages, page.messages);
      updated = page.updatesCursor ?? updated; cursor = page.nextCursor;
    } while (cursor);
    const recent = await readAdminChat(chat, signal);
    return { messages: mergeAdminMessages(messages, recent.messages), nextCursor: recent.nextCursor, updatesCursor: updated };
  }
  let page = await readAdminChat(chat, signal);
  const messages = [...page.messages];
  while (lastId && page.nextCursor && (!page.messages.length || BigInt(page.messages[0].id) > BigInt(lastId))) {
    page = await readAdminChat(chat, signal, page.nextCursor);
    messages.unshift(...page.messages);
  }
  return { messages, nextCursor: page.nextCursor, updatesCursor: page.updatesCursor };
}
/** Обновляет существующие реплики, добавляет новые и сохраняет порядок источника. */
export function mergeAdminMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}
