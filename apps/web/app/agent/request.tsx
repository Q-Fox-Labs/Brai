"use client";
// ABOUTME: Показывает ожидающие решения в shared карточках и уведомляет об отказах.
// ABOUTME: Отправляет решение только для поддерживаемого ожидающего native запроса.
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PendingRequest } from "@brai/agent/contracts";
type Decision = string | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: string; host: string } } };
function rejectionText(reason?: string) {
  return ({
    "unsupported-method": "Codex отправил запрос, который Brai не поддерживает. Запрос отклонён; отвечать не нужно.",
    "invalid-params": "Codex отправил параметры запроса в неподдерживаемом формате. Запрос отклонён; отвечать не нужно.",
    "request-too-large": "Превышен лимит отдельного запроса Codex к Brai. Это ограничение запроса, а не длины вашего сообщения. Запрос отклонён; отвечать не нужно.",
    "too-many-pending": "У Brai уже есть максимальное число ожидающих запросов Codex. Новый запрос отклонён; отвечать на него не нужно.",
    "presentation-limit": "Brai не может безопасно показать этот запрос Codex. Запрос отклонён; отвечать не нужно.",
  } as Record<string, string>)[reason ?? ""] ?? "Brai отклонил запрос Codex, который не может обработать. Ответ не требуется.";
}

function decisionLabel(choice: Decision): string {
  if (typeof choice === "string") return ({ accept: "Разрешить один раз", acceptForSession: "Разрешить для этого сеанса", decline: "Отклонить", cancel: "Отклонить и остановить ход" } as Record<string, string>)[choice] ?? "Неподдерживаемое решение";
  if ("acceptWithExecpolicyAmendment" in choice) return `Разрешить и больше не спрашивать для команд «${choice.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ")}»`;
  const rule = choice.applyNetworkPolicyAmendment.network_policy_amendment;
  return `${rule.action === "allow" ? "Всегда разрешать" : "Всегда запрещать"} доступ к ${rule.host}`;
}

/** Показывает только предложенные сервером решения; принятый или неизвестный исход блокирует повтор. */
export default function NativeForm({ request, disabled, send }: { request: PendingRequest; disabled: boolean; send: (answer: unknown) => Promise<boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({}), [sent, setSent] = useState(false), [hidden, setHidden] = useState(false), sending = useRef(false);
  const p = request.params;
  const approval = request.kind === "command-approval" || request.kind === "file-change-approval";
  const choices: Decision[] = request.kind === "file-change-approval" ? ["accept", "acceptForSession", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  if (request.kind === "unsupported") {
    // AIDEV-NOTE: Старые снимки могут содержать отказы чужим dynamicTools; это не запрос к пользователю.
    if (hidden || request.method === "item/tool/call") return null;
    return <section className="agent-request-wrap" data-request-id={request.requestId}><details className="agent-request agent-request-notice">
      <summary>Техническое уведомление Codex</summary>
      <p>{rejectionText(request.reason)}</p>
      <code>{request.method}</code>
      <Button type="button" variant="ghost" size="sm" onClick={() => setHidden(true)}>Скрыть уведомление</Button>
    </details></section>;
  }
  function answer(value: unknown) {
    if (sent || sending.current || disabled || request.answered) return;
    sending.current = true; setSent(true);
    void send(value).then(accepted => { if (!accepted) { sending.current = false; setSent(false); } });
  }
  const button = (choice: Decision, index: number) => <Button type="button" key={index} variant={choice === "accept" ? "default" : "outline"} className={choice === "accept" ? "agent-approval-accept" : ""} onClick={() => answer({ decision: choice })}>{decisionLabel(choice)}</Button>;
  return <form className="agent-request" data-request-id={request.requestId} data-request-kind={request.kind} onSubmit={event => {
    event.preventDefault();
    if (!approval) answer({ permissions: values.decision === "grant" ? p.permissions : {}, scope: "turn" });
  }}><Card className="agent-request-card">
    <fieldset disabled={disabled || sent || request.answered}>
      <legend>{approval ? "Запрос разрешения" : "Дополнительные права"}</legend>
      {approval ? <>
        <p className="agent-request-question">{p.reason || (request.kind === "command-approval" ? "Разрешить выполнение команды?" : "Разрешить изменения файлов?")}</p>
        {(p.command || p.cwd || p.grantRoot) && <details className="agent-request-details"><summary>Подробности</summary>{p.command && <pre>{p.command}</pre>}{p.cwd && <p>Рабочая папка: {p.cwd}</p>}{p.grantRoot && <p>Доступ к папке: {p.grantRoot}</p>}</details>}
        <div className="agent-request-actions">{choices.map((choice, index) => typeof choice === "string" && choice !== "acceptForSession" ? button(choice, index) : null)}</div>
        {choices.some(choice => typeof choice !== "string" || choice === "acceptForSession") && <details className="agent-request-options"><summary>Другие варианты разрешения</summary><div className="agent-request-actions">{choices.map((choice, index) => typeof choice !== "string" || choice === "acceptForSession" ? button(choice, index) : null)}</div></details>}
      </> : <>
        {p.reason && <p className="agent-request-question">{p.reason}</p>}
        <details><summary>Запрошенные права</summary><pre>{JSON.stringify(p.permissions, null, 2)}</pre></details><label>Решение <select required value={values.decision ?? ""} onChange={event => setValues({ decision: event.target.value })}><option value="">Выберите решение</option><option value="grant">Предоставить запрошенные права на ход</option><option value="none">Не предоставлять</option></select></label>
        <Button type="submit">Отправить ответ</Button>
      </>}
      {(sent || request.answered) && <p className="agent-note" role="status">Ответ отправлен</p>}
    </fieldset>
  </Card></form>;
}
