"use client";
// ABOUTME: Показывает дневные сегменты истории и позволяет править исходную сессию целиком.
// ABOUTME: Статистика дня приходит полностью от сервиса; история страницы её не подменяет.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Crown, Timer, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TimeEditor } from "./timer-history-time-editor";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { formatDuration } from "../lib/model";
import type { Active, Interval, Statistics } from "../lib/types";
import { applyEditInput, applyEditStep, createEditDraft, draftChanged, draftRange, editRangeError, formatEditValue, formatHistoryDuration, formatIntervalEdge, groupIntervalsByMoscowDate, normalizeEditValue, type EditDraft, type EditField, type IntervalSegment } from "./timer-history-model";
import "./timer-history.css";

const russianDayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });

const fields: { key: EditField; label: string }[] = [
 { key: "start", label: "Старт" },
 { key: "duration", label: "Итого" },
 { key: "end", label: "Финиш" },
];

function formatCompactSessionDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours <= 0) return `${minutes}м`;
  if (minutes <= 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}

function formatPanelDayTotal(ms: number): string {
 const minutes = Math.floor(Math.round(Math.max(0, ms) / 1000) / 60);
 const hours = Math.floor(minutes / 60), remainder = minutes % 60;
 if (hours === 0 && remainder === 0) return "0 мин";
 if (hours === 0) return `${remainder} мин`;
 return remainder === 0 ? `${hours} ч` : `${hours} ч ${remainder} мин`;
}

function formatPanelDate(date: string): string {
 const [year, month, day] = date.split("-").map(Number);
 if (!year || !month || !day) return date;
 return russianDayFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatPanelPercent(value: number): string {
 const safe = Number.isFinite(value) ? value : 0;
 if (safe === 0) return "0%";
 return safe < 100 ? `${safe.toFixed(1).replace(".", ",")}%` : `${safe.toFixed(0)}%`;
}

type Props = {
 items: Interval[];
 active: Active | null;
 statistics: Statistics | null;
 totalCompletedMs: number | null;
 cursor: string | null;
 loading: boolean;
 connected: boolean;
 onLoadMore: () => void;
 onEdit: (timerId: string, startedAt: string, stoppedAt: string) => string | null;
 onDelete: (timerId: string) => string | null;
};

/** Показывает загруженные записи, сохраняя canonical идентификаторы и owner totals. */
export default function TimerHistory({ items, active, statistics, totalCompletedMs, cursor, loading, connected, onLoadMore, onEdit, onDelete }: Props) {
 const days = useMemo(() => groupIntervalsByMoscowDate(items), [items]);
 const [draft, setDraft] = useState<EditDraft | null>(null);
 const [activeRowId, setActiveRowId] = useState<string | null>(null);
 const [editingField, setEditingField] = useState<EditField | null>(null);
 const [inputValue, setInputValue] = useState("");
 const [editorError, setEditorError] = useState("");
 const [deleteId, setDeleteId] = useState<string | null>(null);
 const [deleteError, setDeleteError] = useState("");
 useEffect(() => {
  if (draft && !items.some(item => item.timerId === draft.timerId)) { setDraft(null); setActiveRowId(null); setEditingField(null); setInputValue(""); setEditorError(""); }
  if (deleteId && !days.some(day => day.items.some(segment => segment.rowId === deleteId))) { setDeleteId(null); setDeleteError(""); }
 }, [items, days, draft, deleteId]);

 function closeEditor() { setDraft(null); setActiveRowId(null); setEditingField(null); setInputValue(""); setEditorError(""); }
 function openEditor(segment: IntervalSegment) {
  if (activeRowId === segment.rowId) return;
  if (draft && !save()) return;
  const next = createEditDraft(segment.interval);
  if (!next) { setEditorError("Не удалось открыть запись с некорректным диапазоном."); return; }
  setDraft(next); setActiveRowId(segment.rowId); setEditingField(null); setInputValue(""); setEditorError(""); setDeleteId(null);
 }
 function update(next: EditDraft | null) {
  if (!next) { setEditorError("Финиш должен быть позже старта."); return; }
  const error = editRangeError(next, items, active);
  if (error) { setEditorError(error); return; }
  setDraft(next); setEditorError("");
 }
 function beginInput(field: EditField) {
  if (!draft) return;
  const current = editingField ? commitInput() : draft;
  if (!current) return;
  setEditingField(field); setInputValue(formatEditValue(field, current.startMs, current.endMs)); setEditorError("");
 }
 function commitInput(): EditDraft | null {
  if (!draft || !editingField) return draft;
  const normalized = normalizeEditValue(editingField, inputValue);
  const next = normalized ? applyEditInput(draft, editingField, normalized) : null;
  if (!next) { setEditorError(editingField === "duration" ? "Введите длительность в формате ЧЧ:ММ больше нуля." : "Введите время в формате ЧЧ:ММ."); return null; }
  const error = editRangeError(next, items, active);
  if (error) { setEditorError(error); return null; }
  setDraft(next); setEditingField(null); setInputValue(normalized ?? ""); setEditorError("");
  return next;
 }
 function step(field: EditField, direction: -1 | 1) {
  const current = editingField ? commitInput() : draft;
  if (current) update(applyEditStep(current, field, direction));
 }
 function save(): boolean {
  const current = editingField ? commitInput() : draft;
  if (!current) return false;
  if (!draftChanged(current)) { closeEditor(); return true; }
  const error = editRangeError(current, items, active);
  if (error) { setEditorError(error); return false; }
  const range = draftRange(current);
  const commandId = onEdit(current.timerId, range.startedAt, range.stoppedAt);
  if (!commandId) { setEditorError("Изменение не поставлено в очередь. Повторите сохранение."); return false; }
  closeEditor();
  return true;
 }
 function deleteInterval(timerId: string) {
  const commandId = onDelete(timerId);
  if (!commandId) { setDeleteError("Удаление не поставлено в очередь. Повторите попытку."); return; }
  setDeleteId(null); setDeleteError("");
  if (draft?.timerId === timerId) closeEditor();
 }

 return <section className="timer-history-content" aria-label="История фокуса">
  <div className="timer-history-global-total" aria-label="Общее сохранённое время"><span>Всего</span><strong>{totalCompletedMs === null ? "…" : formatDuration(totalCompletedMs)}</strong></div>
  {items.length === 0 ? <p className="timer-history-v2-empty">{loading || totalCompletedMs === null ? "Загружаем историю…" : "Пока нет завершённых интервалов."}</p> : null}
  {days.map(day => {
   const stats = statistics?.daily.find(entry => entry.date === day.date) ?? null;
   return <div className="history-group relative flex w-full min-w-0 flex-col rounded-2xl bg-muted/72 p-1" data-slot="frame" key={day.date}>
    <Collapsible defaultOpen>
     <header className="flex flex-row items-center justify-between gap-2 px-2 py-2" data-slot="frame-panel-header">
      <CollapsibleTrigger className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:[&_svg]:rotate-180">
       <ChevronDown className="size-4 shrink-0 transition-transform" aria-hidden="true" />
       <span className="min-w-0 truncate">{formatPanelDate(day.date)}</span>
      </CollapsibleTrigger>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
       {stats?.achieved ? <Crown className="size-3.5 shrink-0 text-primary" aria-label="Цель достигнута" /> : null}
       <span className="w-12 text-right text-xs font-normal text-primary tabular-nums">{stats ? formatPanelPercent(stats.percent) : "…"}</span>
       <span className="w-24 max-w-24 text-right text-sm font-semibold text-primary tabular-nums">{stats ? formatPanelDayTotal(stats.completedMs) : "…"}</span>
      </div>
     </header>
     <CollapsibleContent>
      <Table className="timer-history-table" variant="card"><colgroup className="timer-history-columns"><col className="timer-history-time-column" /><col /><col className="timer-history-kind-column" /></colgroup><TableBody>
       {day.items.map(segment => {
        const item = segment.interval;
        return <Fragment key={segment.rowId}>
        <TableRow className="timer-history-entry h-12 cursor-pointer overflow-hidden transition-colors" onClick={() => openEditor(segment)} data-timer-id={item.timerId} data-segment-id={segment.rowId} data-state={activeRowId === segment.rowId ? "selected" : undefined}>
         <TableCell className="h-12 px-1.5 py-0">
          <button className="grid h-12 w-full grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-2 text-left font-normal tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" type="button" onClick={event => { event.stopPropagation(); openEditor(segment); }} aria-label={`Редактировать: ${formatIntervalEdge(segment.startedAt, day.date)} — ${formatHistoryDuration(segment.durationMs)} — ${formatIntervalEdge(segment.stoppedAt)}`}>
           <time className="justify-self-start" dateTime={segment.startedAt} title={`Начало: ${new Date(segment.startedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`}>{formatIntervalEdge(segment.startedAt, day.date)}</time>
           <div className="grid min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-center text-muted-foreground before:border-muted-foreground before:border-t before:border-dashed before:opacity-55 after:border-muted-foreground after:border-t after:border-dashed after:opacity-55"><span className="shrink-0 font-medium text-primary" title={formatHistoryDuration(segment.durationMs)}>{formatCompactSessionDuration(segment.durationMs / 1000)}</span></div>
           <time className="justify-self-end text-right" dateTime={segment.stoppedAt} title={`Финиш: ${new Date(segment.stoppedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`}>{formatIntervalEdge(segment.stoppedAt)}</time>
          </button>
         </TableCell>
         <TableCell className="timer-history-entry-label h-12 min-w-0 px-1.5 py-0"><span className="block truncate font-medium">В фокусе</span>{segment.split ? <small title="Редактирование и удаление применяются ко всей сессии">Часть сессии</small> : null}</TableCell>
         <TableCell className="h-12 px-0.5 py-0 text-center"><Badge aria-label="Фокус" title="Фокус" className="h-7 min-w-7 px-0 font-normal tabular-nums" variant="outline"><Timer aria-hidden="true" /></Badge></TableCell>
        </TableRow>
        {draft && activeRowId === segment.rowId ? <TableRow className="timer-history-editor"><TableCell className="!p-0 !ps-0 !pe-0" colSpan={3}>
         <div className="timer-history-editor-bar grid h-14 w-full grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 px-2 py-1.5" data-nav-swipe-exclusion>
          <div className="grid min-w-0 grid-cols-3 gap-1.5">{fields.map(({ key, label }) => <TimeEditor
           key={key}
           changed={key === "start" ? draft.startMs !== draft.originalStartMs : key === "end" ? draft.endMs !== draft.originalEndMs : draft.endMs - draft.startMs !== draft.originalEndMs - draft.originalStartMs}
           editing={editingField === key}
           featured={key === "duration"}
           field={key}
           label={label}
           inputValue={inputValue}
           onBeginInput={beginInput}
           onCancelInput={() => { setEditingField(null); setEditorError(""); }}
           onCommitInput={commitInput}
           onInput={setInputValue}
           onStep={direction => step(key, direction)}
           value={formatEditValue(key, draft.startMs, draft.endMs)}
          />)}</div>
          <div className="timer-history-editor-actions flex h-10 items-center justify-end gap-0.5 border-l pl-1">
           <Button aria-label="Отменить редактирование фокуса" title="Отмена" className="size-6 text-muted-foreground" onClick={closeEditor} size="icon-sm" type="button" variant="ghost"><X className="size-3.5" aria-hidden="true" /></Button>
           <Button aria-label="Удалить запись фокуса" title="Удалить" className="size-6 text-destructive" onClick={() => { setDeleteId(segment.rowId); setDeleteError(""); closeEditor(); }} size="icon-sm" type="button" variant="ghost"><Trash2 className="size-3.5" aria-hidden="true" /></Button>
           <Button aria-label="Закрыть редактирование фокуса" title="Сохранить" className="size-6 text-foreground" onClick={save} size="icon-sm" type="button" variant="ghost"><Check className="size-3.5" aria-hidden="true" /></Button>
          </div>
         </div>
         {segment.split ? <p className="timer-history-editor-note">Изменения применятся ко всей сессии, включая части в других днях.</p> : null}
         {editorError ? <p className="timer-history-editor-error" role="alert">{editorError}</p> : null}
        </TableCell></TableRow> : null}
        {deleteId === segment.rowId ? <TableRow className="timer-history-delete"><TableCell colSpan={3}>
         <span>{segment.split ? "Удалить всю сессию, включая части в других днях?" : "Удалить всю сессию из истории?"}</span>{deleteError ? <span className="timer-history-editor-error" role="alert">{deleteError}</span> : null}<div><Button onClick={() => { setDeleteId(null); setDeleteError(""); }} type="button" variant="outline">Отмена</Button><Button onClick={() => deleteInterval(item.timerId)} type="button" variant="destructive">Удалить</Button></div>
        </TableCell></TableRow> : null}
       </Fragment>;
       })}
      </TableBody></Table>
     </CollapsibleContent>
    </Collapsible>
   </div>;
  })}
  {statistics === null ? <p className="timer-history-v2-note">Дневные итоги загружаются…</p> : null}
  {cursor ? <div className="timer-history-v2-more"><Button disabled={loading || !connected} onClick={onLoadMore} type="button" variant="outline">{loading ? "Загрузка…" : connected ? "Загрузить ещё" : "Нет соединения"}</Button></div> : null}
 </section>;
}
