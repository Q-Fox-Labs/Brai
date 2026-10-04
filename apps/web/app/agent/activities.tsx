// ABOUTME: Раскрывает группу действий, затем отдельно читает полное содержимое каждого действия.
// ABOUTME: Пустые группы скрыты; закрытые группы не читают содержимое; рассуждения используют Markdown.
import { useEffect, useState } from "react";
import type { DisplayItem } from "@brai/agent/contracts";
import type { LazyReads } from "../../lib/agent/lazy";
import Markdown from "./markdown";
import "./activities.css";
type Context = { generation: string; epoch: string; projectId: string; threadId: string };
type Props = { items: DisplayItem[]; context: Context; reads: LazyReads };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Не удалось загрузить действие.";
const label = (item: DisplayItem) => ({ commandExecution: "Команда", fileChange: "Изменения файлов", reasoning: "Рассуждение", plan: "План", mcpToolCall: "Инструмент", dynamicToolCall: "Инструмент", collabAgentToolCall: "Совместная работа" } as Record<string, string>)[item.type] ?? "Действие агента";

/** До первого раскрытия получает только компактные идентификаторы из history/live. */
export default function Activities({ items, context, reads }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DisplayItem[] | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const signature = JSON.stringify(items.map(item => [item.id, item.turnId, item.revision ?? 0]));
  useEffect(() => {
    if (!open || !items.length) return;
    let current = true;
    setError("");
    setLoading(true);
    void reads.summaries(context, items).then(value => { if (current) setData(value); }).catch(value => { if (current) setError(errorText(value)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
    // AIDEV-NOTE: Только ID/revision меняют скрытые записи; новый массив snapshot сам по себе не требует чтения.
  }, [open, reads, context.generation, context.epoch, context.projectId, context.threadId, signature, retry]);
  const visible = data?.filter(item => item.type !== "reasoning" || item.summary?.trim());
  if (!items.length || items.every(item => item.type === "reasoning" && item.hasContent === false) || (visible?.length === 0 && !loading && !error)) return null;
  return <details className="agent-activity-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Думаю <span className="agent-note">{visible?.length ?? items.length}</span></summary>
    {open && <div className="agent-activity-list">
    {loading && <p className="agent-note" role="status">{data ? "Обновляем действия…" : "Загружаем действия…"}</p>}
    {error && <p className="agent-note" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Повторить</button></p>}
    {visible?.map(item => <Activity key={item.id} item={item} context={context} reads={reads} />)}
    </div>}
  </details>;
}
function Activity({ item, context, reads }: { item: DisplayItem; context: Context; reads: LazyReads }) {
  const [open, setOpen] = useState(false);
  return <article data-item-id={item.id} className="agent-item agent-tool-item"><details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{label(item)}</span>{item.type === "reasoning" ? <div className="agent-activity-title agent-reasoning-title"><Markdown text={item.summary ?? ""} /></div> : <span className="agent-activity-title">{item.summary}</span>}<span className="agent-note">{item.status === "inProgress" ? "Выполняется" : item.status === "failed" ? "Ошибка" : item.status === "completed" ? "Готово" : ""}{item.exitCode !== undefined && ` · код ${item.exitCode}`}</span></summary>
    {open && <ActivityDetail key={`${context.generation}:${context.epoch}:${item.revision ?? 0}`} item={item} context={context} reads={reads} />}
  </details></article>;
}
function ActivityDetail({ item, context, reads }: { item: DisplayItem; context: Context; reads: LazyReads }) {
  const [data, setData] = useState<DisplayItem | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    void reads.detail(context, item).then(value => { if (current) setData(value); }).catch(value => { if (current) setError(errorText(value)); });
    return () => { current = false; };
  }, [reads, context, item, retry]);
  return <div className="agent-activity-detail">
    {!data && !error && <p className="agent-note" role="status">Загружаем содержимое…</p>}
    {error && <p className="agent-note" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Повторить</button></p>}
    {data && <>{data.text && (data.type === "reasoning" ? <Markdown text={data.text} /> : <pre>{data.text}</pre>)}{data.command !== undefined && <pre className="agent-code">{data.command}</pre>}{data.output !== undefined && <pre className="agent-code">{data.output}</pre>}{data.diff !== undefined && <pre className="agent-code">{data.diff}</pre>}{data.truncated && <p className="agent-note">Элемент сокращён</p>}</>}
  </div>;
}
