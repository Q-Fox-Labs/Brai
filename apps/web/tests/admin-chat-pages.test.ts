// ABOUTME: Проверяет объединение страниц административного чата.
// ABOUTME: Использует fixture фактического DTO identity control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChatPage } from "../app/admin/chat-pages.ts";
test("all cursor pages remain readable in order and new chat replaces old data", () => {
 const first = mergeChatPage(null, { messages: [{ id: "1", role: "user", text: "Первое", createdAt: "2026-11-05" }], nextCursor: "cursor-1" }, false);
 const second = mergeChatPage(first, { messages: [{ id: "2", role: "assistant", text: "Второе", createdAt: "2026-11-05" }], nextCursor: "cursor-2" }, true);
 const third = mergeChatPage(second, { messages: [{ id: "3", role: "user", text: "Третье", createdAt: "2026-11-05" }], nextCursor: null }, true);
 assert.deepEqual(third.messages.map(item => (item as { id: string }).id), ["1", "2", "3"]);
 assert.equal(third.nextCursor, null);
 assert.deepEqual(mergeChatPage(third, { messages: [], nextCursor: null }, false), { messages: [], nextCursor: null });
 assert.throws(() => mergeChatPage(null, { messages: [], nextCursor: "cursor" }, true));
 assert.throws(() => mergeChatPage(first, { messages: [], nextCursor: "" }, true));
});
