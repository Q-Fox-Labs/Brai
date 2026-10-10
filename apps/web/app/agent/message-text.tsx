// ABOUTME: Дочитывает длинные сообщения и descriptors новых результатов для Markdown.
// ABOUTME: Поздние ответы отбрасываются; ошибка чтения доступна для повторной попытки.
import { useEffect, useState } from "react";
import type { DisplayItem } from "@brai/agent/contracts";
import type { LazyReads } from "../../lib/agent/lazy";
import { desktopMessage } from "../../lib/agent/desktop-message";
import { questionReplies } from "../../lib/agent/question-reply";
import Markdown from "./markdown";
type Props = { item: DisplayItem; context: { generation: string; epoch: string; projectId: string; threadId: string }; reads: LazyReads };

/** Загружает сокращённый текст через общий кеш; полное сообщение показывает без маркеров сокращения. */
export default function MessageText({ item, context, reads }: Props) {
  const [full, setFull] = useState<DisplayItem | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const missingResults = item.type === "agentMessage" && (item.resultCount ?? 0) > 0 && !item.results?.length && item.resultsState !== "unavailable";
  useEffect(() => {
    let current = true;
    setFull(null); setError(false);
    if (item.truncated || missingResults || retry > 0) void reads.detail(context, item, missingResults || retry > 0).then(value => { if (current) setFull(value); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [reads, context.generation, context.epoch, context.projectId, context.threadId, item.id, item.turnId, item.revision, item.text, item.truncated, item.resultCount, item.resultsState, missingResults, retry]);
  const value = full ?? item, complete = !value.truncated;
  const text = complete ? value.text : value.text.replace(/\n\[содержимое сокращено\]$/, "");
  const replies = item.type === "userMessage" && complete ? questionReplies(text) : null;
  return <>
    {replies ? <div className="agent-markdown">{replies.map((reply, index) => <div key={index}><p>{reply.question}</p><p><strong>Ответ: </strong>{reply.answer}</p></div>)}</div> : <Markdown text={item.type === "userMessage" ? desktopMessage(text) : text} results={value.results ?? item.results} />}
    {!complete && <p role="status">{error ? "Не удалось загрузить полное сообщение." : "Загружаем полное сообщение…"}{error && <button type="button" onClick={() => { setError(false); setRetry(value => value + 1); }}>Повторить</button>}</p>}
    {complete && (value.resultsState === "unavailable" || value.results?.some(result => result.state === "unavailable") || (missingResults && error)) && <p role="status">{error ? "Не удалось обновить результаты." : "Некоторые результаты недоступны."} <button type="button" onClick={() => { setError(false); setRetry(value => value + 1); }}>Повторить загрузку результатов</button></p>}
    {complete && item.type === "agentMessage" && item.phase === "final_answer" && <span className="agent-message-read-marker" data-read-message={item.id} aria-hidden="true" />}
  </>;
}
