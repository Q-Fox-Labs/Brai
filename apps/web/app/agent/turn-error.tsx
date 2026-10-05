"use client";
// ABOUTME: Показывает в истории сообщения об ошибках завершившегося хода Codex.
// ABOUTME: Не отправляет повторный запрос и не раскрывает дополнительные сведения upstream.
type TurnError = { message: string; code?: string };
export default function TurnErrorNotice({ error }: { error: TurnError }) {
  const overloaded = error.code === "serverOverloaded" || /Selected model is at capacity/i.test(error.message);
  return <section className="agent-turn-error" role="alert">
    <strong>{overloaded ? "Выбранная модель перегружена" : "Codex завершил ход с ошибкой"}</strong>
    <p>{error.message}</p>
    {overloaded && <p>Выберите другую модель в панели сообщения или повторите запрос позже.</p>}
  </section>;
}
