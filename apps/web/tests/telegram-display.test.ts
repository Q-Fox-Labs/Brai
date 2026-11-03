// ABOUTME: Проверяет очистку только подтверждённых вложений в Telegram-переписке.
// ABOUTME: Проверяет сохранение пользовательских подписей и посторонних ссылок.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTelegramMessage, telegramText, updateTelegramMessage } from "../app/agent/telegram-display.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const audio = "33333333-3333-4333-8333-333333333333";
test("убирает только служебные строки и ссылки готовых изображений", () => {
  const text = `Подпись пользователя\n[artifactId=${first}]\n[artifactId=${second}]\n[Image attached at: /tmp/results/${first}/a.jpg]\n[Image attached at: /tmp/results/${second}/b.jpg]\n[screenshot]\n[screenshot]`;
  assert.equal(telegramText(text, [{ artifactId: first, mimeType: "image/jpeg" }, { artifactId: second, mimeType: "image/jpeg" }]), "Подпись пользователя");
  assert.match(telegramText(text, []), /artifactId=/);
});
test("заменяет только связанный дескриптор голосового на плеер", () => {
  const text = `Распознанный текст\n[audio.ogg](</tmp/results/${audio}/audio.ogg>)`;
  assert.equal(telegramText(text, [{ artifactId: audio, mimeType: "audio/ogg" }]), "Распознанный текст");
  assert.equal(telegramText(text, []), text);
  assert.equal(telegramText("[screenshot]", []), "[screenshot]");
});

test("объясняет пустое сообщение без предположений о старых данных", () => {
  assert.match(emptyTelegramMessage(), /тип неизвестен/);
  assert.match(emptyTelegramMessage("unknown"), /тип неизвестен/);
  assert.match(emptyTelegramMessage("service"), /Служебное/);
  assert.match(emptyTelegramMessage("unsupported:contact"), /не поддерживается/);
});

test("объединяет квитанцию и прямое наблюдение одной отправки", () => {
  const pending = { identity: "pending:job", telegram_id: null as string | null, direction: "out", text: "Ждёт" };
  const direct = { identity: "telegram:1:7", telegram_id: "7", direction: "out", text: "Ответ" };
  const delivered = { ...pending, telegram_id: "7", text: "Ответ" };
  assert.deepEqual(updateTelegramMessage([pending, direct], delivered), [delivered]);
  assert.equal(updateTelegramMessage([pending], direct), null);
});
