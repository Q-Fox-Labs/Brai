// ABOUTME: Извлекает понятные ответы из служебной записи вопросов Codex.
// ABOUTME: Распознаёт только полное сообщение; исходную историю не меняет.
export type QuestionReply = { question: string; answer: string };

/** Возвращает вопросы с ответами либо null для обычного или повреждённого сообщения. */
export function questionReplies(text: string): QuestionReply[] | null {
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (!match) return null;
  try {
    const rows: unknown = JSON.parse(match[1]);
    if (!Array.isArray(rows) || !rows.length || !rows.every(row => row && typeof row === "object" && typeof row.questionItemId === "string" && typeof row.question === "string" && typeof row.answer === "string")) return null;
    return rows.map(({ question, answer }) => ({ question, answer }));
  } catch { return null; }
}
