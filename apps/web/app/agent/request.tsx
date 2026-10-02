"use client";
// ABOUTME: Показывает вопрос и понятные действия для ожидающего native запроса.
// ABOUTME: Отправляет исходное решение без изменения его области и без повторной отправки.
import { useRef, useState } from "react";
import type { PendingRequest } from "@brai/agent/contracts";
type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] };
type Decision = string | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: string; host: string } } };

function decisionLabel(choice: Decision): string {
  if (typeof choice === "string") return ({ accept: "Разрешить один раз", acceptForSession: "Разрешить для этого сеанса", decline: "Отклонить", cancel: "Отклонить и остановить ход" } as Record<string, string>)[choice] ?? "Неподдерживаемое решение";
  if ("acceptWithExecpolicyAmendment" in choice) return `Разрешить и больше не спрашивать для команд «${choice.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ")}»`;
  const rule = choice.applyNetworkPolicyAmendment.network_policy_amendment;
  return `${rule.action === "allow" ? "Всегда разрешать" : "Всегда запрещать"} доступ к ${rule.host}`;
}

/** Показывает только предложенные сервером решения; принятый или неизвестный исход блокирует повтор. */
export default function NativeForm({ request, disabled, send }: { request: PendingRequest; disabled: boolean; send: (answer: unknown) => Promise<boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({}), [sent, setSent] = useState(false), sending = useRef(false);
  const p = request.params, questions: Question[] = p.questions ?? [];
  const approval = request.kind === "command-approval" || request.kind === "file-change-approval";
  const choices: Decision[] = request.kind === "file-change-approval" ? ["accept", "acceptForSession", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  if (request.kind === "unsupported") return <p>Запрос пока не поддерживается: {request.reason ?? request.method}</p>;
  function answer(value: unknown) {
    if (sent || sending.current || disabled || request.answered) return;
    sending.current = true; setSent(true);
    void send(value).then(accepted => { if (!accepted) { sending.current = false; setSent(false); } });
  }
  const button = (choice: Decision, index: number) => <button type="button" key={index} className={choice === "accept" ? "agent-approval-accept" : ""} onClick={() => answer({ decision: choice })}>{decisionLabel(choice)}</button>;
  return <form className="agent-request" data-request-id={request.requestId} data-request-kind={request.kind} onSubmit={event => {
    event.preventDefault();
    if (!approval) answer(request.kind === "question" ? { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [values[q.id]] }])) } : { permissions: values.decision === "grant" ? p.permissions : {}, scope: "turn" });
  }}>
    <fieldset disabled={disabled || sent || request.answered}>
      <legend>{approval ? "Запрос разрешения" : request.kind === "question" ? "Вопрос агента" : "Дополнительные права"}</legend>
      {approval ? <>
        <p className="agent-request-question">{p.reason || (request.kind === "command-approval" ? "Разрешить выполнение команды?" : "Разрешить изменения файлов?")}</p>
        {(p.command || p.cwd || p.grantRoot) && <details className="agent-request-details"><summary>Подробности</summary>{p.command && <pre>{p.command}</pre>}{p.cwd && <p>Рабочая папка: {p.cwd}</p>}{p.grantRoot && <p>Доступ к папке: {p.grantRoot}</p>}</details>}
        <div className="agent-request-actions">{choices.map((choice, index) => typeof choice === "string" && choice !== "acceptForSession" ? button(choice, index) : null)}</div>
        {choices.some(choice => typeof choice !== "string" || choice === "acceptForSession") && <details className="agent-request-options"><summary>Другие варианты разрешения</summary><div className="agent-request-actions">{choices.map((choice, index) => typeof choice !== "string" || choice === "acceptForSession" ? button(choice, index) : null)}</div></details>}
      </> : <>
        {p.reason && <p className="agent-request-question">{p.reason}</p>}
        {request.kind === "question" ? questions.map(q => <label key={q.id} className="block">{q.header}: {q.question}{q.options?.length && !q.isOther ? <select required value={values[q.id] ?? ""} onChange={event => setValues({ ...values, [q.id]: event.target.value })}><option value="">Выберите ответ</option>{q.options.map(option => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select> : <><input required type={q.isSecret ? "password" : "text"} autoComplete="off" list={q.options?.length && !q.isSecret ? `${request.requestId}-${q.id}` : undefined} value={values[q.id] ?? ""} onChange={event => setValues({ ...values, [q.id]: event.target.value })} /><datalist id={`${request.requestId}-${q.id}`}>{q.options?.map(option => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist></>}</label>) : <><details><summary>Запрошенные права</summary><pre>{JSON.stringify(p.permissions, null, 2)}</pre></details><label>Решение <select required value={values.decision ?? ""} onChange={event => setValues({ decision: event.target.value })}><option value="">Выберите решение</option><option value="grant">Предоставить запрошенные права на ход</option><option value="none">Не предоставлять</option></select></label></>}
        <button>Отправить ответ</button>
      </>}
      {(sent || request.answered) && <p className="agent-note" role="status">Ответ отправлен</p>}
    </fieldset>
  </form>;
}
