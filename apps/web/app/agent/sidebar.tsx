"use client";
// ABOUTME: Показывает группы проектов и названия чатов в левой панели.
// ABOUTME: Только выбор и раскрытие списка; запросы и команды принадлежат экрану.
import { useEffect, useState } from "react";
import * as Separator from "@radix-ui/react-separator";
import type { AgentLimits, ThreadMetadata } from "@brai/agent/contracts";
import { formatLimitReset } from "../../lib/agent/limits";

export type Project = { projectId: string; name: string; available: boolean };
export type ThreadPage = { data: ThreadMetadata[]; nextCursor: string | null; loading: boolean; error: string };
type Props = {
  projects: Project[]; pages: Record<string, ThreadPage>; projectId: string; threadId: string;
  open: boolean; email: string; busy: boolean; accountLimits: AgentLimits;
  select: (projectId: string, threadId?: string) => void;
  create: (projectId: string) => void; more: (projectId: string) => void; refresh: (projectId: string) => void;
  close: () => void; logout: () => void;
};

/** Группирует уже прочитанные чаты; длинное название доступно полностью через title. */
export default function Sidebar({ projects, pages, projectId, threadId, open, email, busy, accountLimits, select, create, more, refresh, close, logout }: Props) {
  const [visible, setVisible] = useState<Record<string, number>>({});
  return <aside id="agent-sidebar" className="agent-sidebar" data-open={open} aria-label="Проекты и чаты" onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <header className="agent-sidebar-header"><h2 className="agent-brand">Проекты</h2><button className="agent-sidebar-close" aria-label="Закрыть список чатов" onClick={close}>×</button></header>
    <Separator.Root className="agent-separator" />
    <nav className="agent-projects" aria-label="Проекты и чаты">
      {!projects.length && <p className="agent-sidebar-note">Загружаем проекты…</p>}
      {projects.map((project, index) => {
        const page = pages[project.projectId], count = visible[project.projectId] ?? 5;
        return <section className="agent-project" key={project.projectId} aria-label={project.name}>
          <div className="agent-project-heading">
            <button className="agent-project-select" aria-label={`Проект ${project.name}`} aria-pressed={projectId === project.projectId} disabled={!project.available} onClick={() => select(project.projectId)}>
              <svg className={`agent-project-icon agent-project-color-${index % 3}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="m8 12 3 2-3 2m6 0h3" /></svg>
              <span>{project.name}</span><span className={`agent-project-dot ${project.available ? "is-available" : ""}`} title={project.available ? "Проект доступен" : "Проект недоступен"} />
            </button>
            <button className="agent-icon-button" aria-label={`Новый чат в ${project.name}`} title="Новый чат" disabled={!project.available || busy} onClick={() => create(project.projectId)}>+</button>
          </div>
          <div className="agent-thread-list">
            {sortThreads(page?.data ?? []).slice(0, count).map(thread => {
              const title = thread.title || thread.preview || "Новый чат", selected = projectId === project.projectId && threadId === thread.id;
              return <button key={thread.id} data-thread-id={thread.id} className={`agent-thread ${selected ? "is-selected" : ""}`} title={title} aria-pressed={selected} onClick={() => select(project.projectId, thread.id)}><span className="agent-thread-title">{title}</span>{thread.active && <span className="agent-thread-spinner" role="status" aria-label="Агент работает" />}</button>;
            })}
            {page?.error && <p className="agent-sidebar-note" role="alert">Не удалось загрузить чаты. <button onClick={() => refresh(project.projectId)}>Повторить</button></p>}
            {page?.loading && <p className="agent-sidebar-note" role="status">Загружаем чаты…</p>}
            {page && !page.loading && !page.error && !page.data.length && <p className="agent-sidebar-note">Пока нет чатов</p>}
            {page && (page.data.length > count || page.nextCursor) && <button className="agent-more" disabled={page.loading} onClick={() => { if (count >= page.data.length) more(project.projectId); setVisible(previous => ({ ...previous, [project.projectId]: count + 5 })); }}>Показать больше</button>}
          </div>
        </section>;
      })}
    </nav>
    <Separator.Root className="agent-separator" />
    <footer className="agent-sidebar-footer"><span className="agent-account" title={email}>{email}</span><div><button onClick={logout}>Выйти</button></div><AccountLimits value={accountLimits} /></footer>
  </aside>;
}

function durationLabel(minutes: number | null) {
  if (minutes === null) return "";
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return minutes % 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes / 60} ч`;
  const days = Math.floor(minutes / 1440), remainder = minutes % 1440;
  const wholeDays = days % 7 ? `${days} дн.` : `${days / 7} нед.`;
  return remainder ? `${wholeDays} ${Math.floor(remainder / 60)} ч${remainder % 60 ? ` ${remainder % 60} мин` : ""}` : wholeDays;
}

function AccountLimits({ value }: { value: AgentLimits }) {
  const stateLabel = value.state === "loading" ? "Загрузка лимитов" : value.state === "unavailable" ? "Лимиты недоступны" : value.state === "stale" ? "Данные устарели" : value.windows.length ? "" : "Нет доступных окон";
  return <section className="agent-limits" aria-label="Лимиты Codex">
    <div className="agent-limits-heading"><span>Codex</span>{stateLabel && <span role="status">{stateLabel}</span>}</div>
    {value.windows.map(window => <LimitWindow key={window.slot} window={window} stale={value.state === "stale"} />)}
  </section>;
}

function LimitWindow({ window, stale }: { window: AgentLimits["windows"][number]; stale: boolean }) {
  const [reset, setReset] = useState<{ label: string; title: string; iso: string; value: number | null } | null>(null);
  useEffect(() => { const formatted = formatLimitReset(window.resetsAt); setReset(formatted ? { ...formatted, value: window.resetsAt } : null); }, [window.resetsAt]);
  const slot = window.slot === "primary" ? "Основное" : "Дополнительное";
  const duration = durationLabel(window.windowDurationMins);
  return <div className="agent-limit-window">
    <div className="agent-limit-label"><span>{slot}{duration && ` · ${duration}`}</span><span>Осталось {window.remainingPercent}%</span></div>
    <div className="agent-limit-track" role="progressbar" aria-label={`${slot} окно Codex, осталось ${window.remainingPercent}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
      <span style={{ width: `${window.remainingPercent}%` }} />
    </div>
    <div className="agent-limit-reset">{stale && <span>Устарело · </span>}{reset?.value === window.resetsAt ? <time dateTime={reset.iso} title={reset.title}>{reset.label}</time> : <span>сброс неизвестен</span>}</div>
  </div>;
}

/** Служебный updatedAt не поднимает чат; равные метки сохраняют порядок native страницы. */
export function sortThreads(threads: ThreadMetadata[]): ThreadMetadata[] {
  return threads.map((thread, index) => ({ thread, index })).sort((a, b) => (b.thread.lastMessageAt ?? 0) - (a.thread.lastMessageAt ?? 0) || a.index - b.index).map(value => value.thread);
}
