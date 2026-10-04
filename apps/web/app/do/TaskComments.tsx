"use client";
// ABOUTME: Сохраняет исходную форму и ленту комментариев September.
// ABOUTME: Комментарии принадлежат синтетическому экрану и не отправляются на сервер.
import { useEffect, useState } from "react";
import { formatShortDateTime } from "./format";
import { useTasks } from "./TasksContext";

/** Показывает исходный UI комментариев и сохраняет их в локальном контроллере. */
export default function TaskComments({ taskId, onCountChange }: { taskId: string; onCountChange: (count: number) => void }) {
  const { commentsByTask, addComment, setError } = useTasks();
  const comments = commentsByTask[taskId] ?? [];
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const isLoading = false, isCreating = false;
  useEffect(() => onCountChange(comments.length), [comments.length, onCountChange]);
  const createComment = () => {
    if (!body.trim()) { setError("Текст комментария не может быть пустым"); return; }
    addComment(taskId, { title: title.trim() || null, body: body.trim() });
    setTitle(""); setBody("");
  };
  return (
    <section className="grid gap-5" aria-label="Комментарии">
      {isLoading && comments.length === 0 ? (
        <p className="m-0 text-[13px] text-brai-muted">Загрузка…</p>
      ) : comments.length === 0 ? (
        <p className="m-0 text-[13px] text-brai-muted">Комментариев пока нет</p>
      ) : (
        <ol className="m-0 grid list-none gap-3 p-0">
          {comments.map((comment) => (
            <li className="rounded-lg border border-brai-line bg-brai-surface-subtle px-3 py-3" key={comment.id}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-brai-muted">
                <span className={comment.authorId === "agent:codex" ? "font-medium text-brai-accent" : "font-mono break-all"}>
                  {comment.authorId === "agent:codex" ? "Codex" : comment.authorId}
                </span>
                <span aria-hidden="true">·</span>
                <time dateTime={new Date(comment.createdAt).toISOString()}>
                  {formatShortDateTime(comment.createdAt)}
                </time>
              </div>
              {comment.title && (
                <h3 className="m-0 mt-2 text-[14px] font-semibold text-brai-ink">
                  {comment.title}
                </h3>
              )}
              <p className="m-0 mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-brai-ink">
                {comment.body}
              </p>
            </li>
          ))}
        </ol>
      )}

      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void createComment();
        }}
      >
        <input
          className="w-full rounded-lg border border-brai-line bg-brai-surface-subtle px-3 py-2 text-[13px] text-brai-ink outline-none placeholder:text-brai-muted focus:border-brai-accent/50 focus:shadow-[0_0_0_3px_var(--surface-focus)] disabled:cursor-wait disabled:opacity-65"
          type="text"
          value={title}
          maxLength={255}
          placeholder="Заголовок (не обязательно)"
          aria-label="Заголовок комментария (не обязательно)"
          disabled={isCreating}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <textarea
          className="min-h-24 w-full resize-y rounded-lg border border-brai-line bg-brai-surface-subtle px-3 py-2 text-[13px] leading-5 text-brai-ink outline-none placeholder:text-brai-muted focus:border-brai-accent/50 focus:shadow-[0_0_0_3px_var(--surface-focus)] disabled:cursor-wait disabled:opacity-65"
          value={body}
          maxLength={2000}
          rows={4}
          placeholder="Комментарий"
          aria-label="Комментарий"
          disabled={isCreating}
          spellCheck
          onChange={(event) => setBody(event.currentTarget.value)}
        />
        <div className="flex justify-end">
          <button
            className="rounded-lg border border-brai-accent/35 bg-brai-accent px-3 py-2 text-[13px] font-medium text-white hover:bg-brai-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brai-accent/40 disabled:cursor-wait disabled:opacity-60"
            type="submit"
            disabled={isCreating}
          >
            {isCreating ? "Добавляется…" : "Добавить"}
          </button>
        </div>
      </form>
    </section>
  );
}
