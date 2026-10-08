"use client";
// ABOUTME: Показывает проекты, чаты и лимиты в компактном рейле Brai-Old.
// ABOUTME: Сворачивание и порядок сохраняются для пользователя; запросами владеет экран.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentLimits, ThreadMetadata } from "@brai/agent/contracts";
import { formatLimitReset, limitCountdown } from "../../lib/agent/limits";

export type Project = { projectId: string; name: string; available: boolean };
export type ThreadPage = { data: ThreadMetadata[]; nextCursor: string | null; loading: boolean; error: string };
type Props = {
  projects: Project[]; pages: Record<string, ThreadPage>; projectId: string; threadId: string;
  open: boolean; email: string; busy: boolean; accountLimits: AgentLimits; readMessages?: Record<string, string>;
  select: (projectId: string, threadId?: string) => void;
  create: (projectId: string) => void; more: (projectId: string) => void; refresh: (projectId: string) => void;
  archive: (projectId: string, threadId: string) => void;
  close: () => void; logout: () => void;
};

/** Группирует чаты; заголовки сворачивают группы и переносят их без смены открытого чата. */
export default function Sidebar({ projects, pages, projectId, threadId, open, email, busy, accountLimits, readMessages = {}, select, create, more, refresh, archive, close }: Props) {
  const [visible, setVisible] = useState<Record<string, number>>({});
  const [preferences, setPreferences] = useState<{ order: string[]; collapsed: string[] }>({ order: [], collapsed: [] });
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const storageKey = `brai.agent.projects:${email}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string");
      setPreferences(saved && validIds(saved.order) && validIds(saved.collapsed) ? saved : { order: [], collapsed: [] });
    } catch { setPreferences({ order: [], collapsed: [] }); }
  }, [storageKey]);
  const save = (next: typeof preferences) => {
    setPreferences(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Настройки остаются в памяти без доступа к хранилищу. */ }
  };
  const orderedProjects = [...projects].sort((a, b) => {
    const rank = (id: string) => { const index = preferences.order.indexOf(id); return index < 0 ? preferences.order.length : index; };
    return rank(a.projectId) - rank(b.projectId);
  });
  const finishDragging = () => { setDragged(null); setDropTarget(null); suppressClickUntil.current = Date.now() + 150; };
  return <aside id="agent-sidebar" className="agent-sidebar" data-open={open} aria-label="Проекты и чаты" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) close(); }}>
    <header className="agent-sidebar-header"><h2 className="agent-brand">Проекты</h2><Button type="button" variant="ghost" size="icon-sm" className="agent-sidebar-close" aria-label="Закрыть список чатов" onClick={close}>×</Button></header>
    <Separator className="agent-separator" />
    <ScrollArea className="agent-projects" contentInset="none"><nav className="agent-project-list" aria-label="Проекты и чаты">
      {!projects.length && <p className="agent-sidebar-note">Загружаем проекты…</p>}
      {orderedProjects.map(project => {
        const index = projects.indexOf(project), collapsed = preferences.collapsed.includes(project.projectId);
        const page = pages[project.projectId], count = visible[project.projectId] ?? 5;
        return <section className={`agent-project ${dragged === project.projectId ? "is-dragging" : ""}`} key={project.projectId} aria-label={project.name} data-project-id={project.projectId} data-drop-position={dropTarget?.id === project.projectId ? (dropTarget.after ? "after" : "before") : undefined}
          onDragOver={event => {
            if (!dragged || dragged === project.projectId) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.querySelector(".agent-project-heading")!.getBoundingClientRect();
            setDropTarget({ id: project.projectId, after: event.clientY >= bounds.top + bounds.height / 2 });
          }}
          onDragLeave={event => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDropTarget(current => current?.id === project.projectId ? null : current);
          }}
          onDrop={event => {
            if (!dragged || dragged === project.projectId) return;
            event.preventDefault(); event.stopPropagation();
            const bounds = event.currentTarget.querySelector(".agent-project-heading")!.getBoundingClientRect();
            const order = orderedProjects.map(value => value.projectId).filter(id => id !== dragged);
            order.splice(order.indexOf(project.projectId) + Number(event.clientY >= bounds.top + bounds.height / 2), 0, dragged);
            save({ ...preferences, order }); finishDragging();
          }}>
          <div className="agent-project-heading">
            <Button type="button" variant="ghost" className="agent-project-select" aria-label={`Проект ${project.name}`} aria-expanded={!collapsed} aria-controls={`agent-project-chats-${project.projectId}`} draggable
              onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-brai-agent-project", project.projectId); setDragged(project.projectId); setDropTarget(null); suppressClickUntil.current = Infinity; }}
              onDragEnd={finishDragging}
              onClick={() => { if (Date.now() < suppressClickUntil.current) return; save({ ...preferences, collapsed: collapsed ? preferences.collapsed.filter(id => id !== project.projectId) : [...preferences.collapsed, project.projectId] }); }}>
              <svg className={`agent-project-icon agent-project-color-${index % 3}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="m8 12 3 2-3 2m6 0h3" /></svg>
              <span>{project.name}</span><span className={`agent-project-dot ${project.available ? "is-available" : ""}`} title={project.available ? "Проект доступен" : "Проект недоступен"} />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" className="agent-icon-button" aria-label={`Новый чат в ${project.name}`} title="Новый чат" onClick={() => { if (collapsed) save({ ...preferences, collapsed: preferences.collapsed.filter(id => id !== project.projectId) }); create(project.projectId); }}>+</Button>
          </div>
          <div id={`agent-project-chats-${project.projectId}`} className="agent-thread-list" hidden={collapsed}>
            {sortThreads(page?.data ?? []).slice(0, count).map(thread => {
              const title = thread.title || thread.preview || "Новый чат", selected = projectId === project.projectId && threadId === thread.id;
              return <div key={thread.id} data-thread-id={thread.id} className={`agent-thread ${selected ? "is-selected" : ""}`}>
                <Button type="button" variant="ghost" className="agent-thread-select" title={title} aria-pressed={selected} onClick={() => select(project.projectId, thread.id)}><span className="agent-thread-title">{title}</span>{thread.awaitingReply ? <span className="agent-thread-indicator is-question" role="status" aria-label="Агент ждёт ответа" title="Агент ждёт ответа">?</span> : thread.active ? <span className="agent-thread-spinner" role="status" aria-label="Агент работает" /> : thread.finalMessageId && readMessages[`${project.projectId}:${thread.id}`] !== thread.finalMessageId ? <span className="agent-thread-indicator is-completed" role="status" aria-label="Непрочитанный итог" title="Непрочитанный итог"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></span> : null}</Button>
                <ThreadActions title={title} disabled={busy || !project.available} archive={() => archive(project.projectId, thread.id)} />
              </div>;
            })}
            {page?.error && <p className="agent-sidebar-note" role="alert">Не удалось загрузить чаты. <Button type="button" variant="link" size="sm" onClick={() => refresh(project.projectId)}>Повторить</Button></p>}
            {page?.loading && <p className="agent-sidebar-note" role="status">Загружаем чаты…</p>}
            {page && !page.loading && !page.error && !page.data.length && <p className="agent-sidebar-note">Пока нет чатов</p>}
            {page && (page.data.length > count || page.nextCursor) && <Button type="button" variant="ghost" size="sm" className="agent-more" disabled={page.loading} onClick={() => { if (count >= page.data.length) more(project.projectId); setVisible(previous => ({ ...previous, [project.projectId]: count + 5 })); }}>Показать больше</Button>}
          </div>
        </section>;
      })}
    </nav></ScrollArea>
    <footer className="agent-sidebar-footer"><AccountLimits value={accountLimits} /></footer>
  </aside>;
}

/** Native popover закрывается снаружи и по Escape, не обрезаясь прокруткой списка. */
function ThreadActions({ title, disabled, archive }: { title: string; disabled: boolean; archive: () => void }) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  return <>
    <button ref={trigger} type="button" className="agent-thread-actions" aria-label={`Меню чата: ${title}`} title="Меню чата" popoverTarget={id} disabled={disabled} onClick={() => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition({ left: Math.max(8, rect.right - 176), top: Math.min(rect.bottom + 4, window.innerHeight - 56) });
    }}>⋯</button>
    <div ref={menu} id={id} popover="auto" className="agent-thread-menu" style={position} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { menu.current?.hidePopover(); archive(); }}>Архивировать</Button>
    </div>
  </>;
}

function AccountLimits({ value }: { value: AgentLimits }) {
  const stateLabel = value.state === "loading" ? "Загрузка лимитов" : value.state === "unavailable" ? "Лимиты недоступны" : value.windows.length ? "" : "Нет доступных окон";
  // AIDEV-NOTE: Единичный сбой опроса не должен мигать надписями рядом с сохранённой квотой.
  return <section className="agent-limits" aria-label="Лимиты Codex" title={value.state === "stale" ? "Обновление лимита задерживается. Показаны последние полученные данные." : undefined}>
    {stateLabel && <div className="agent-limits-heading"><span role="status">{stateLabel}</span></div>}
    {value.windows.map(window => <LimitWindow key={window.slot} window={window} />)}
  </section>;
}

function LimitWindow({ window }: { window: AgentLimits["windows"][number] }) {
  const [reset, setReset] = useState<{ label: string; title: string; iso: string; value: number | null } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { const formatted = formatLimitReset(window.resetsAt); setReset(formatted ? { ...formatted, value: window.resetsAt } : null); }, [window.resetsAt]);
  const slot = window.slot === "primary" ? "Codex" : "Дополнительное";
  const countdown = now === null ? null : limitCountdown(window.resetsAt, window.windowDurationMins, now);
  return <div className="agent-limit-window">
    <div className="agent-limit-label"><span>{slot}</span><span>Осталось {window.remainingPercent}%</span></div>
    <div className="agent-limit-track" role="progressbar" aria-label={`${slot} окно Codex, осталось ${window.remainingPercent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
      <span style={{ width: `${window.remainingPercent}%` }} />
    </div>
    {countdown?.percent != null && <div className="agent-limit-track agent-limit-time-track" role="progressbar" aria-label={`${slot} окно Codex, время до сброса`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={countdown.percent} aria-valuetext={countdown.label}>
      <span style={{ width: `${countdown.percent}%` }} />
    </div>}
    <div className="agent-limit-reset">{reset?.value === window.resetsAt ? <time dateTime={reset.iso} title={reset.title}>{reset.label}</time> : <span>сброс неизвестен</span>}{countdown && ` · ${countdown.label}`}</div>
  </div>;
}

/** Служебный updatedAt не поднимает чат; равные метки сохраняют порядок native страницы. */
export function sortThreads(threads: ThreadMetadata[]): ThreadMetadata[] {
  return threads.map((thread, index) => ({ thread, index })).sort((a, b) => (b.thread.lastMessageAt ?? 0) - (a.thread.lastMessageAt ?? 0) || a.index - b.index).map(value => value.thread);
}
