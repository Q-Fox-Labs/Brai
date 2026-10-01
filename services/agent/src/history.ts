// ABOUTME: Читает ограниченные страницы ходов и элементов Codex.
// ABOUTME: Удаляет raw reasoning и связывает курсор с project/thread/turn.

import { validateDto, serializedBytes } from "../contracts/index.mjs";
import type { HistoryRequest, HistoryResponse } from "../contracts/index.mjs";
import type { CodexPort } from "./ports.js";
import type { Session } from "./state.js";

type Cursor = {
  p: string;
  t: string;
  explicit: boolean;
  turn: string | null;
  item: string | null;
  turns: string | null;
  offset: number;
};
const encode = (x: Cursor): string =>
  Buffer.from(JSON.stringify(x)).toString("base64url");
function decode(value: string): Cursor | null {
  try {
    const x = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    ) as Partial<Cursor>;
    return typeof x.p === "string" &&
      typeof x.t === "string" &&
      typeof x.explicit === "boolean" &&
      (x.turn === null || typeof x.turn === "string") &&
      (x.item === null || typeof x.item === "string") &&
      (x.turns === null || typeof x.turns === "string") &&
      Number.isSafeInteger(x.offset) &&
      x.offset! >= 0
      ? (x as Cursor)
      : null;
  } catch {
    return null;
  }
}
const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
function safeText(
  value: unknown,
  cap = 1000,
): { content: string; bytes: number; truncated: boolean } {
  const source = typeof value === "string" ? value : "";
  const bytes = Buffer.byteLength(source);
  if (bytes <= cap) return { content: source, bytes, truncated: false };
  let content = source;
  while (Buffer.byteLength(content) > cap)
    content = content.slice(
      0,
      Math.max(
        0,
        content.length - Math.ceil((Buffer.byteLength(content) - cap) / 2),
      ),
    );
  return { content, bytes, truncated: true };
}
function invalid(code: string, outcome: "not-sent" | "query"): never {
  throw Object.assign(new Error(code), { code, outcome });
}

/** Возвращает одну bounded-страницу; курсор продолжает items, затем turns. */
export async function readHistory(
  codex: CodexPort,
  session: Session,
  request: HistoryRequest,
): Promise<HistoryResponse> {
  if (!validateDto("HistoryRequest", request))
    invalid("INVALID_ARGUMENT", "not-sent");
  if (
    request.projectId !== session.projectId ||
    request.threadId !== session.threadId
  )
    invalid("INVALID_ARGUMENT", "not-sent");
  if (session.knownNew)
    return {
      generation: session.generation,
      items: [],
      nextCursor: null,
      truncation: { truncated: false, reason: "none" },
    };

  const limit = Math.min(100, Math.max(1, request.limit ?? 50));
  let cursor: Cursor = {
    p: request.projectId,
    t: request.threadId,
    explicit: Boolean(request.turnId),
    turn: request.turnId ?? null,
    item: null,
    turns: null,
    offset: 0,
  };
  if (request.cursor) {
    const parsed = decode(request.cursor);
    if (
      !parsed ||
      parsed.p !== request.projectId ||
      parsed.t !== request.threadId ||
      Boolean(request.turnId) !== parsed.explicit ||
      (request.turnId !== undefined && request.turnId !== parsed.turn)
    )
      invalid("INVALID_ARGUMENT", "not-sent");
    cursor = parsed;
  }

  if (!cursor.turn) {
    const turnPage = record(
      await codex.call(
        "thread/turns/list",
        {
          threadId: request.threadId,
          limit: 1,
          sortDirection: "asc",
          itemsView: "notLoaded",
          ...(cursor.turns ? { cursor: cursor.turns } : {}),
        },
        { mutation: false },
      ),
    );
    const turns = Array.isArray(turnPage.data) ? turnPage.data : [];
    const current = turns.length ? record(turns[0]) : null;
    if (!current && typeof turnPage.nextCursor !== "string") {
      const empty: HistoryResponse = {
        generation: session.generation,
        items: [],
        nextCursor: null,
        truncation: { truncated: false, reason: "none" },
      };
      return empty;
    }
    cursor = {
      ...cursor,
      turn: typeof current?.id === "string" ? current.id : null,
      turns:
        typeof turnPage.nextCursor === "string" ? turnPage.nextCursor : null,
      item: null,
      offset: cursor.offset,
    };
    if (!cursor.turn) {
      const response: HistoryResponse = {
        generation: session.generation,
        items: [],
        nextCursor: encode(cursor),
        truncation: { truncated: true, reason: "upstream-limit" },
      };
      return response;
    }
  }

  const page = record(
    await codex.call(
      "thread/items/list",
      {
        threadId: request.threadId,
        turnId: cursor.turn,
        limit,
        sortDirection: "asc",
        ...(cursor.item ? { cursor: cursor.item } : {}),
      },
      { mutation: false },
    ),
  );
  const rows = Array.isArray(page.data) ? page.data : [];
  let truncated = false;
  const items = rows.map((raw: unknown, index: number) => {
    const entry = record(raw);
    const item = record(entry.item);
    const type = typeof item.type === "string" ? item.type : "other";
    const itemId =
      typeof item.id === "string"
        ? item.id
        : `unknown-${cursor.offset + index}`;
    // 500 UTF-8 bytes per text field bounds escaped 100-item pages below the DTO limit.
    // Reasoning публикует только upstream summary; content и другие поля не сериализуются.
    const text =
      type === "reasoning"
        ? safeText(
            Array.isArray(item.summary) ? item.summary.join("\n") : "",
            500,
          )
        : type === "agentMessage"
          ? safeText(item.text, 500)
          : type === "userMessage"
            ? safeText(
                (Array.isArray(item.content) ? item.content : [])
                  .filter((part: any) => part.type === "text")
                  .map((part: any) => part.text)
                  .join("\n"),
                500,
              )
            : type === "commandExecution"
              ? safeText(item.command, 500)
              : type === "fileChange"
                ? safeText(
                    (Array.isArray(item.changes) ? item.changes : [])
                      .map(
                        (change: any) =>
                          `${change.path ?? ""}\n${change.diff ?? ""}`,
                      )
                      .join("\n"),
                    500,
                  )
                : type === "webSearch"
                  ? safeText(item.query, 500)
                  : safeText("");
    const traceType:
      "command" | "output" | "file-change" | "message" | "other" =
      type === "commandExecution"
        ? "command"
        : type === "fileChange"
          ? "file-change"
          : type === "agentMessage" || type === "userMessage"
            ? "message"
            : type === "commandExecutionOutput"
              ? "output"
              : "other";
    const phase =
      type === "agentMessage" &&
      (item.phase === "commentary" || item.phase === "final_answer")
        ? { phase: item.phase }
        : {};
    const output =
      type === "commandExecution" ? safeText(item.aggregatedOutput, 500) : null;
    const itemTruncated = text.truncated || Boolean(output?.truncated);
    if (itemTruncated) truncated = true;
    return {
      itemId,
      order: cursor.offset + index,
      kind: type,
      content: text.content,
      truncated: itemTruncated,
      contentBytes: text.bytes,
      turnId: typeof entry.turnId === "string" ? entry.turnId : cursor.turn!,
      trace: {
        type: traceType,
        status: typeof item.status === "string" ? item.status : "unknown",
        ...(traceType === "command" && text.content
          ? { command: text.content }
          : {}),
        ...(output?.content ? { output: output.content } : {}),
        ...(typeof item.exitCode === "number" || item.exitCode === null
          ? { exitCode: item.exitCode }
          : {}),
        ...phase,
      },
    };
  });
  if (serializedBytes(items) > 700 * 1024) {
    for (const item of items) {
      item.content = `[content omitted; ${item.contentBytes} bytes]`;
      item.truncated = true;
      item.trace = {
        ...item.trace,
        ...(item.trace.command
          ? {
              command: `[content omitted; ${Buffer.byteLength(item.trace.command)} bytes]`,
            }
          : {}),
        ...(item.trace.output
          ? {
              output: `[content omitted; ${Buffer.byteLength(item.trace.output)} bytes]`,
            }
          : {}),
        status: "content-omitted",
      };
    }
    truncated = true;
  }
  let next: string | null = null;
  if (typeof page.nextCursor === "string")
    next = encode({
      ...cursor,
      item: page.nextCursor,
      offset: cursor.offset + rows.length,
    });
  else if (cursor.turns)
    next = encode({
      ...cursor,
      turn: null,
      item: null,
      turns: cursor.turns,
      offset: cursor.offset + rows.length,
    });
  const response: HistoryResponse = {
    generation: session.generation,
    items,
    nextCursor: next,
    truncation: { truncated, reason: truncated ? "byte-budget" : "none" },
  };
  if (serializedBytes(response) > 768 * 1024)
    invalid("ITEM_TOO_LARGE", "query");
  if (!validateDto("HistoryResponse", response))
    invalid("UNSUPPORTED", "query");
  return response;
}
