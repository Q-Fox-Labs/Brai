// ABOUTME: Проверяет преобразование выбора пользователя в ответы native форм.
// ABOUTME: Использует те же функции, которыми экран собирает RPC payload.
import assert from "node:assert/strict";
import test from "node:test";
import { approvalAnswer, permissionsAnswer, questionAnswer } from "../app/agent/forms.ts";

test("вопросы с текстовым ответом, Other и вариантами сохраняют выбранное значение", () => {
  const questions = [
    { id: "free", header: "Свободный", question: "Ответ" },
    { id: "choice", header: "Выбор", question: "Выберите", options: [{ label: "A", description: "Первый" }] },
    { id: "other", header: "Свой вариант", question: "Выберите", isOther: true, options: [{ label: "A", description: "Первый" }] },
  ];
  assert.deepEqual(questionAnswer(questions, { choice: "A", other: "A" }, { free: "свой ответ", other: "свой вариант" }, { other: true }), {
    answer: { answers: { free: { answers: ["свой ответ"] }, choice: { answers: ["A"] }, other: { answers: ["свой вариант"] } } },
  });
  assert.deepEqual(questionAnswer(questions.slice(1), { choice: "A", other: "A" }, { other: "текст" }, { other: false }), {
    answer: { answers: { choice: { answers: ["A"] }, other: { answers: ["A"] } } },
  });
  assert.deepEqual(questionAnswer(questions.slice(0, 1), {}, { free: "" }, {}), { error: "Ответьте на вопрос «Свободный»." });
});

test("разрешение использует запрошенный профиль или пустой профиль на этот ход", () => {
  const requested = { fileSystem: { write: ["/workspace"] }, network: { enabled: true } };
  assert.deepEqual(permissionsAnswer("grant", requested), { permissions: requested, scope: "turn" });
  assert.deepEqual(permissionsAnswer("none", requested), { permissions: {}, scope: "turn" });
  assert.equal(permissionsAnswer("", requested), null);
});

test("решение approval сохраняет точный предложенный объект поправки", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git status"] } };
  const selected = JSON.stringify(amendment);
  assert.deepEqual(approvalAnswer(selected, ["accept", amendment]), { decision: amendment });
  assert.equal(approvalAnswer("acceptForSession", ["accept"]), null);
});
