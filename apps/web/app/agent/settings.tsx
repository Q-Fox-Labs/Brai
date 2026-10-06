// ABOUTME: Shared controls представляют режимы, разрешения и native каталог моделей.
// ABOUTME: Ползунки передают выбор экрану и не запускают задания.
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentMode, ModelChoice, PermissionMode, ContextUsage } from "@brai/agent/contracts";

const effortLabels: Record<string, [string, string]> = {
  minimal: ["Min", "Minimal"], low: ["Low", "Low"], medium: ["Med", "Medium"],
  high: ["Hgh", "High"], xhigh: ["XHi", "Extra high"], max: ["Max", "Maximum"], ultra: ["Ult", "Ultra"],
};
const modelOrder = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
const modelLabels: Record<string, string> = { "gpt-6-luna": "Lun", "gpt-6.1-sol": "Sol", "gpt-6-astra": "Ast" };
const modes: AgentMode[] = ["default", "plan", "goal"];
const modeLabels = { default: "Обычный", plan: "План", goal: "Цель" };
const permissions: PermissionMode[] = ["ask", "auto", "full"];
const permissionLabels = { ask: "Запрашивать разрешение", auto: "Подтверждать за меня", full: "Полный доступ" };

export function ComposerIcon({ kind }: { kind: AgentMode | PermissionMode | "send" | "stop" | "plus" | "resize" }) {
  const paths = {
    default: <path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z" />,
    plan: <><path d="M9 5h11M9 12h11M9 19h11" /><path d="m3 5 1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2" /></>,
    goal: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    ask: <><path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5Z" /><path d="M10 9a2 2 0 0 1 4 0c0 2-2 2-2 4m0 3h.01" /></>,
    auto: <><path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5Z" /><path d="m8 12 3 3 5-6" /></>,
    full: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M9 10V6a4 4 0 0 1 8 0m-5 9v2" /></>,
    send: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    plus: <path d="M12 5v14M5 12h14" />,
    resize: <path d="m5 19 14-14m-6 14 6-6" />,
  };
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export function AgentModeButton({ mode, disabled, choose }: { mode: AgentMode; disabled: boolean; choose: (mode: AgentMode) => void }) {
  const label = `Режим агента: ${modeLabels[mode]}`;
  return <Button type="button" variant="outline" size="icon-sm" className="agent-composer-icon" title={label} aria-label={label} disabled={disabled} onClick={() => choose(modes[(modes.indexOf(mode) + 1) % modes.length])}><ComposerIcon kind={mode} /></Button>;
}

function SettingSlider({ label, options, value, disabled, choose }: { label: string; options: { value: string; short: string; title: string }[]; value: string; disabled: boolean; choose: (value: string) => void }) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[index];
  const position = options.length > 1 ? index / (options.length - 1) : 0;
  const unavailable = disabled || options.length < 2;
  return <div className="agent-setting-slider" data-disabled={unavailable} title={`${label}: ${selected?.title ?? "Загрузка…"}`}>
    <span className="agent-setting-track" aria-hidden="true" />
    {options.map((option, point) => <span key={option.value} className="agent-setting-point" aria-hidden="true" style={{ left: `calc(18px + ${options.length > 1 ? point / (options.length - 1) : 0} * (100% - 36px))` }} />)}
    <span className="agent-setting-thumb" aria-hidden="true" style={{ left: `calc(${position} * (100% - 36px))` }}>{selected?.short ?? "…"}</span>
    <input type="range" aria-label={label} aria-valuetext={selected?.title ?? "Загрузка…"} min={0} max={Math.max(0, options.length - 1)} step={1} value={index} disabled={unavailable} tabIndex={-1}
      onKeyDown={event => { if (event.key !== "Tab") event.preventDefault(); }}
      onChange={event => { const next = options[Number(event.target.value)]; if (next && next.value !== value) choose(next.value); }} />
  </div>;
}

/** Активный steer сохраняет настройки исполняемого хода. */
export default function ModelSettings({ models, model, effort, permissionMode, disabled, chooseModel, chooseEffort, choosePermissions, contextUsage }: { contextUsage?: ContextUsage | null; models: ModelChoice[]; model: string; effort: string; permissionMode: PermissionMode; choosePermissions: (value: PermissionMode) => void; disabled: boolean; chooseModel: (value: string) => void; chooseEffort: (value: string) => void }) {
  const selected = models.find(value => value.model === model);
  const ordered = modelOrder.flatMap(id => models.filter(value => value.model === id));
  const permissionLabel = `Разрешения: ${permissionLabels[permissionMode]}`;
  return <>
    <Button type="button" variant="outline" size="icon-sm" className="agent-composer-icon" title={permissionLabel} aria-label={permissionLabel} disabled={disabled} onClick={() => choosePermissions(permissions[(permissions.indexOf(permissionMode) + 1) % permissions.length])}><ComposerIcon kind={permissionMode} /></Button>
    <ContextWindow usage={contextUsage} />
    <div className="agent-model-settings">
      <SettingSlider label="Модель" options={ordered.map(value => ({ value: value.model, short: modelLabels[value.model], title: value.name }))} value={model} disabled={disabled} choose={chooseModel} />
      <SettingSlider label="Рассуждение" options={(selected?.efforts ?? []).map(value => ({ value, short: effortLabels[value]?.[0] ?? value.slice(0, 3), title: effortLabels[value]?.[1] ?? value }))} value={effort} disabled={disabled || !selected} choose={chooseEffort} />
    </div>
  </>;
}

/** Показывает последнее измерение Codex; неизвестные данные не подменяет нулём. */
function ContextWindow({ usage }: { usage?: ContextUsage | null }) {
  const [open, setOpen] = useState(false), id = useId();
  const percent = usage?.contextWindow ? Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100)) : null;
  const tokens = (value: number) => value >= 1000 ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value / 1000)} к` : new Intl.NumberFormat("ru-RU").format(value);
  const label = percent === null ? "Контекстное окно: данные недоступны" : `Контекстное окно: ${percent}% использовано`;
  return <div className="agent-context" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <Button type="button" variant="outline" size="icon-sm" className="agent-composer-icon" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={() => setOpen(true)} onFocus={() => setOpen(true)} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); setOpen(false); } }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.5" opacity=".25" />
        {percent !== null && <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.5" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 12 12)" />}
        {percent === null && <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
      </svg>
    </Button>
    {open && <div id={id} role="tooltip" className="agent-context-tooltip">
      <span>Контекстное окно:</span>
      {percent !== null && <><div>{percent}% использовано</div><div>(осталось {100 - percent}%)</div></>}
      {usage ? <div>Использовано {tokens(usage.usedTokens)} /<br />{usage.contextWindow ? `${tokens(usage.contextWindow)} токенов` : "лимит неизвестен"}</div> : <div>Данные пока недоступны</div>}
    </div>}
  </div>;
}
