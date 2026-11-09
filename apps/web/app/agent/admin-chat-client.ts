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
/** Выполняет только чтение; сессия проверяется сервером на каждом запросе. */
export async function chatQuery<T>(operation: string, input: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch("/api/admin?" + new URLSearchParams({ operation, ...input }), { cache: "no-store", signal });
  if (!response.ok) throw new AdminChatError(response.status);
  const value = await response.json() as T;
  if (input.source === "telegram" && (value as { source?: string }).source !== "telegram") throw new AdminChatError(503);
  return value;
}
/** Загружает все страницы профилей, сохраняя доступные чаты при отказе одного источника. */
export async function loadAdminChats(previous: AdminChat[], signal: AbortSignal): Promise<{ chats: AdminChat[]; unavailable: string[] }> {
  const { users } = await chatQuery<{ users: ChatOwner[] }>("users-list", {}, signal);
  const owners: ChatOwner[] = users.filter(user => user.profileId);
  const chats: AdminChat[] = [], unavailable: string[] = [];
  // AIDEV-NOTE: Ограничиваем число одновременно создаваемых снимков на стороне Hermes.
  for (let offset = 0; offset < owners.length; offset += 3) {
    await Promise.all(owners.slice(offset, offset + 3).map(async owner => {
      const items: AdminChat[] = [];
      try {
        let cursor: string | null = null;
        do {
          const page: { items: Omit<AdminChat, "owner">[]; profiles?: TelegramProfile[]; nextCursor: string | null } = await chatQuery("admin-chats-list", { userId: owner.id, source: "telegram", ...(cursor ? { cursor } : {}) }, signal);
          items.push(...page.items.map(item => {
            const profile = page.profiles?.find(profile => profile.telegramId === item.participant?.telegramId);
            return { ...item, owner, participant: profile ? { ...item.participant, ...profile, name: profile.name || item.participant?.name || "" } : item.participant };
          }));
          cursor = page.nextCursor;
        } while (cursor);
        const unique = new Map<string, AdminChat>();
        for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
        chats.push(...unique.values());
      } catch (error) {
        if (signal.aborted || error instanceof AdminChatError && [401, 403].includes(error.status)) throw error;
        unavailable.push(owner.name || owner.telegramId || "Пользователь");
        chats.push(...previous.filter(chat => chat.owner.id === owner.id).map(chat => ({ ...chat, owner })));
      }
    }));
  }
  return { chats: chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || adminChatKey(a).localeCompare(adminChatKey(b))), unavailable };
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
