// ABOUTME: Показывает планы, шаги и цели в shared карточке с ограниченной прокруткой.
// ABOUTME: Не запускает цели самостоятельно; управление передаётся существующему mutation порту.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Material } from "./materials-model";
import type { DisplayItem } from "@brai/agent/contracts";
import Markdown from "./markdown";
import "./materials.css";

type Props = { materials: Material[]; focus: boolean; selected: string; disabled: boolean; active: boolean; connected: boolean; choose: (id: string) => void; close: () => void; execute: (item: DisplayItem) => void; revise: (item: DisplayItem) => void; goal: (action: "pause" | "resume" | "stop") => void };
const goalLabels: Record<string, string> = { active: "Выполняется", paused: "На паузе", blocked: "Заблокирована", usageLimited: "Лимит использования", budgetLimited: "Бюджет исчерпан", complete: "Завершена" };

/** Панель закрывается Escape и возвращает фокус; на мобильном это отдельная полноэкранная область. */
export default function Materials({ materials, focus, selected, disabled, active, connected, choose, close, execute, revise, goal }: Props) {
  const heading = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), closeRef = useRef(close);
  closeRef.current = close;
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = () => setMobile(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const siblings = mobile ? Array.from(panel.current?.closest(".agent-shell")?.querySelectorAll<HTMLElement>(".agent-sidebar, .agent-workspace") ?? []) : [];
    siblings.forEach(element => { element.inert = true; });
    if (mobile || focus) heading.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!mobile || event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const elements = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), a[href], [tabindex='0']") ?? []);
        const first = elements[0], last = elements.at(-1);
        if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); siblings.forEach(element => { element.inert = false; }); if ((mobile || focus) && previous?.isConnected) previous.focus(); };
  }, [mobile, focus]);
  const material = materials.find(value => value.id === selected) ?? materials.at(-1);
  useEffect(() => { if (mobile && !panel.current?.contains(document.activeElement)) heading.current?.focus(); }, [mobile, material?.fingerprint]);
  if (!material) return null;
  return <aside ref={panel} className="agent-materials" role={mobile ? "dialog" : "complementary"} aria-modal={mobile || undefined} aria-label="Материалы" onKeyDown={event => {
    if (!mobile && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); }
  }}>
    <Card className="agent-materials-card"><header className="agent-materials-header">
      {materials.length > 1 ? <select aria-label="Материал" value={material.id} onChange={event => choose(event.target.value)}>{materials.map(value => <option key={value.id} value={value.id}>{value.title}</option>)}</select> : <h2>{material.title}</h2>}
      <button ref={heading} type="button" aria-label="Закрыть материалы" onClick={close}>×</button>
    </header>
    <ScrollArea className="agent-materials-document" contentInset="none"><div className="agent-materials-content">
      {material.kind === "plan" && <>
        <p className="agent-materials-note" role="status">{material.item.status === "completed" ? "Предложенный план" : "План ещё формируется…"}{material.item.truncated && " · Показан сокращённый текст"}</p>
        <Markdown text={material.item.text} />
        <div className="agent-materials-actions">
          <Button type="button" disabled={disabled || active || material.item.status !== "completed" || !!material.item.truncated || !material.item.text.trim()} onClick={() => execute(material.item)}>Выполнить план</Button>
          <Button type="button" variant="outline" disabled={disabled || active} onClick={() => revise(material.item)}>Предложить правки</Button>
        </div>
        {material.item.truncated && <p className="agent-materials-note">Для выполнения нужен полный документ. Текст этого плана сокращён владельцем.</p>}
      </>}
      {material.kind === "progress" && <>
        <p className="agent-materials-note" role="status">{!connected || material.value.state === "stale" ? "Связь прервана. Шаги могли измениться; ждём свежие данные." : material.value.state === "unavailable" ? "Шаги этого хода недоступны после восстановления соединения." : "Текущие шаги выполнения"}</p>
        {material.value.truncated && <p className="agent-materials-note">Часть шагов или текста сокращена.</p>}
        {material.value.explanation && <Markdown text={material.value.explanation} />}
        <ol className="agent-plan-steps">{material.value.steps.map((step, index) => <li key={index}><span className={`agent-plan-step-status is-${step.status}`}>{step.status === "completed" ? "✓ Выполнено" : step.status === "inProgress" ? "◷ Выполняется" : "Ожидает"}</span><Markdown text={step.step} /></li>)}</ol>
        <p className="agent-materials-note">Шаги доступны в текущем подключении. После восстановления соединения они могут быть недоступны.</p>
      </>}
      {material.kind === "goal" && material.value.value && <>
        <p className="agent-materials-note" role="status">{!connected || material.value.state !== "ready" ? "Состояние цели устарело или недоступно. Управление ждёт свежие данные." : goalLabels[material.value.value.status] ?? material.value.value.status}</p>
        <Markdown text={material.value.value.objective} />
        {material.value.value.truncated && <p className="agent-materials-note">Описание цели сокращено.</p>}
        <dl className="agent-goal-metrics">
          {material.value.value.timeUsedSeconds != null && <><dt>Время</dt><dd>{Math.floor(material.value.value.timeUsedSeconds / 60)} мин {Math.floor(material.value.value.timeUsedSeconds % 60)} с</dd></>}
          {material.value.value.tokensUsed != null && <><dt>Токены</dt><dd>{material.value.value.tokensUsed.toLocaleString("ru-RU")}</dd></>}
          {material.value.value.tokenBudget != null && <><dt>Бюджет токенов</dt><dd>{material.value.value.tokenBudget.toLocaleString("ru-RU")}</dd></>}
        </dl>
        <div className="agent-materials-actions">
          {material.value.value.status === "active" && <Button type="button" variant="outline" disabled={disabled || material.value.state !== "ready"} onClick={() => goal("pause")}>Пауза</Button>}
          {material.value.value.status !== "active" && material.value.value.status !== "complete" && <Button type="button" variant="outline" disabled={disabled || material.value.state !== "ready"} onClick={() => goal("resume")}>Продолжить</Button>}
          <Button type="button" variant="destructive" disabled={disabled || material.value.state !== "ready"} onClick={() => goal("stop")}>Удалить цель и остановить</Button>
        </div>
      </>}
    </div></ScrollArea></Card>
  </aside>;
}
