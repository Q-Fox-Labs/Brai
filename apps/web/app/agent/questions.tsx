"use client";
// ABOUTME: Показывает один вопрос в shared controls и собирает native ответы.
// ABOUTME: Выделение не означает выбор; явный пропуск передаётся пустым массивом.
import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PendingRequest } from "@brai/agent/contracts";

type Question = { id: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] | null };
type Props = { request: PendingRequest; disabled: boolean; send: (answer: unknown) => Promise<boolean> };

function Icon({ kind }: { kind: "previous" | "next" | "close" | "edit" | "submit" }) {
  const icons = { previous: ChevronLeft, next: ChevronRight, close: X, edit: PencilLine, submit: ArrowRight };
  const Component = icons[kind];
  return <Component className="size-4" aria-hidden="true" />;
}

/** Сохраняет ответы при навигации и сворачивании; send=true блокирует повтор до сверки. */
export default function QuestionCard({ request, disabled, send }: Props) {
  const questions: Question[] = request.params.questions ?? [];
  const [position, setIndex] = useState(0), [highlighted, setHighlighted] = useState(0), [collapsed, setCollapsed] = useState(false);
  const index = Math.min(position, Math.max(0, questions.length - 1));
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "sending" | "locked">("idle");
  const sending = useRef(false), focusRequested = useRef(false), form = useRef<HTMLFormElement>(null), reopen = useRef<HTMLButtonElement>(null);
  const titleId = useId(), cardId = useId();
  const question = questions[index], blocked = disabled || status !== "idle" || request.answered;
  useEffect(() => {
    if (!focusRequested.current) return;
    focusRequested.current = false;
    if (collapsed) reopen.current?.focus();
    else form.current?.querySelector<HTMLElement>(".agent-question-option.is-active, input, textarea, [data-question-skip]")?.focus();
  }, [index, collapsed]);
  if (!question) return null;
  const options = question.options ?? [], custom = !options.length || question.isOther;
  const draft = drafts[question.id] ?? "";
  const inputProps = {
    value: draft, disabled: blocked, autoComplete: "off", placeholder: options.length ? "Нет. Расскажите Brai, что сделать по-другому" : "Напишите свой ответ",
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDrafts(previous => ({ ...previous, [question.id]: event.target.value }));
      setAnswers(previous => { const next = { ...previous }; delete next[question.id]; return next; });
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault(); if (!event.repeat && draft.trim()) complete([draft]);
    },
  };

  function navigate(next: number, saved = answers) {
    if (next < 0 || next >= questions.length) return;
    const selected = questions[next].options?.findIndex(option => option.label === saved[questions[next].id]?.[0]) ?? -1;
    setHighlighted(Math.max(0, selected)); setIndex(next); focusRequested.current = true;
  }

  function complete(value: string[]) {
    if (blocked || sending.current) return;
    const next = { ...answers, [question.id]: value };
    setAnswers(next);
    if (index < questions.length - 1) { navigate(index + 1, next); return; }
    // AIDEV-NOTE: Неотвеченный вопрос отличается от явного пропуска; навигация не пропускает вопросы.
    const missing = questions.findIndex(value => !Object.hasOwn(next, value.id));
    if (missing !== -1) { navigate(missing, next); return; }
    sending.current = true; setStatus("sending");
    void send({ answers: Object.fromEntries(questions.map(value => [value.id, { answers: next[value.id] }])) }).then(locked => {
      if (locked) setStatus("locked");
      else { sending.current = false; setStatus("idle"); }
    });
  }

  return <section className="agent-questions" data-request-id={request.requestId} data-request-kind="question" aria-label="Вопросы агента">
    {collapsed && <button ref={reopen} type="button" className="agent-question-reopen" aria-expanded="false" aria-controls={cardId} onClick={() => { focusRequested.current = true; setCollapsed(false); }}>Ответить на вопросы <span>{index + 1} из {questions.length}</span><Icon kind="next" /></button>}
    <form ref={form} id={cardId} hidden={collapsed} className="agent-question-form" aria-labelledby={titleId} aria-busy={status === "sending"} onSubmit={event => { event.preventDefault(); if (custom && draft.trim()) complete([draft]); }} onKeyDown={event => {
      if (event.key === "Enter" && event.repeat) event.preventDefault();
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); focusRequested.current = true; setCollapsed(true); }
    }}><Card className="agent-question-card">
      <div className="agent-question-heading">
        <h2 id={titleId} aria-live="polite">{question.question}</h2>
        <div className="agent-question-navigation">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Предыдущий вопрос" disabled={blocked || index === 0} onClick={() => navigate(index - 1)}><Icon kind="previous" /></Button>
          <span aria-live="polite">{index + 1} из {questions.length}</span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Следующий вопрос" disabled={blocked || index === questions.length - 1} onClick={() => navigate(index + 1)}><Icon kind="next" /></Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Свернуть вопросы" onClick={() => { focusRequested.current = true; setCollapsed(true); }}><Icon kind="close" /></Button>
        </div>
      </div>
      <div className="agent-question-body" role="group" aria-labelledby={titleId} aria-disabled={blocked}>
        <div className="agent-question-options">
          {options.map((option, optionIndex) => {
            const recommendation = /\s*\((?:recommended|рекомендуемый|рекомендуется)\)\s*$/i;
            const recommended = recommendation.test(option.label);
            return <Button type="button" variant="ghost" key={option.label} disabled={blocked} data-question-option={optionIndex} className={`agent-question-option${highlighted === optionIndex ? " is-active" : ""}`} aria-pressed={answers[question.id]?.[0] === option.label} onFocus={() => setHighlighted(optionIndex)} onClick={() => complete([option.label])} onKeyDown={event => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const next = (optionIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
              form.current?.querySelector<HTMLElement>(`[data-question-option="${next}"]`)?.focus();
            }}>
              <span className="agent-question-number" aria-hidden="true">{optionIndex + 1}</span>
              <span className="agent-question-option-copy"><span className="agent-question-option-title">{recommended ? option.label.replace(recommendation, "") : option.label}{recommended && <span className="agent-question-recommended">Рекомендуемый</span>}</span><span className="agent-question-description">{option.description}</span></span>
              <span className="agent-question-option-arrow"><Icon kind="submit" /></span>
            </Button>;
          })}
        </div>
        <div className="agent-question-footer">
          {custom && <label className="agent-question-custom"><Icon kind="edit" /><span className="sr-only">{question.isSecret ? "Секретный ответ" : "Свой ответ"}</span>
            {question.isSecret ? <Input {...inputProps} type="password" /> : <Textarea {...inputProps} rows={1} />}
          </label>}
          {custom && draft.trim() ? <Button type="submit" disabled={blocked} className="agent-question-continue">{index === questions.length - 1 ? "Отправить" : "Далее"}<Icon kind="submit" /></Button> : <Button type="button" variant="outline" disabled={blocked} className="agent-question-skip" data-question-skip onClick={() => complete([])}>Пропустить</Button>}
        </div>
      </div>
      {status !== "idle" && <p className="agent-question-status" role="status">{status === "sending" ? "Отправляем ответы…" : "Ожидаем обновления чата…"}</p>}
    </Card></form>
  </section>;
}
