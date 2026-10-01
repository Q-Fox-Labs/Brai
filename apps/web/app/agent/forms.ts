// ABOUTME: Строит точные ответы на нативные формы Codex для agent UI.
// ABOUTME: Функции не отправляют команды и не выбирают решение за пользователя.
import type { CodexToolRequestUserInputParams } from "@brai/agent/contracts";

type Question = CodexToolRequestUserInputParams["questions"][number];

/** Собирает ответ на каждый вопрос, возвращая локальную ошибку до RPC. */
export function questionAnswer(
  questions: Question[],
  selectedAnswers: Record<string, string>,
  freeAnswers: Record<string, string>,
  selectedOther: Record<string, boolean>,
): { answer: { answers: Record<string, { answers: string[] }> } } | { error: string } {
  const mapped: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const value = question.options?.length
      ? question.isOther && selectedOther[question.id] ? freeAnswers[question.id]?.trim() : selectedAnswers[question.id]
      : freeAnswers[question.id]?.trim();
    if (!value?.trim()) return { error: `Ответьте на вопрос «${question.header}».` };
    mapped[question.id] = { answers: [value] };
  }
  return { answer: { answers: mapped } };
}

/** Создаёт явный профиль разрешений только на текущий ход. */
export function permissionsAnswer(choice: string, requested: unknown): { permissions: unknown; scope: "turn" } | null {
  if (choice !== "grant" && choice !== "none") return null;
  return { permissions: choice === "grant" ? requested : {}, scope: "turn" };
}

/** Сохраняет предложенное исполнителем значение, включая объект поправки. */
export function approvalAnswer(selectedKey: string, available: unknown[]): { decision: unknown } | null {
  const choice = available.find(value => (typeof value === "string" ? value : JSON.stringify(value)) === selectedKey);
  return choice === undefined ? null : { decision: choice };
}
