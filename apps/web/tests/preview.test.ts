// ABOUTME: Проверяет runtime-настройки отдельных веб-превью.
// ABOUTME: Не запускает сервер и не обращается к общим данным.
import test from "node:test";
import assert from "node:assert/strict";
import { previewInfo, eventsConsumerName } from "../server/preview.ts";

test("preview requires complete metadata and a separate valid consumer", () => {
  assert.equal(previewInfo({}), null);
  assert.equal(eventsConsumerName({}), "web_events");
  const env = { BRAI_WEB_PREVIEW: "1", BRAI_WEB_PREVIEW_BRANCH: "feature/demo", BRAI_WEB_PREVIEW_SHA: "a".repeat(40), BRAI_WEB_PREVIEW_BACKEND_CHANGED: "1", BRAI_WEB_PREVIEW_EXPIRES_AT: "2026-11-01T00:00:00Z", WEB_EVENTS_CONSUMER: "web_preview_1" };
  assert.equal(previewInfo(env)?.backendChanged, true);
  assert.equal(previewInfo({ ...env, BRAI_WEB_PREVIEW_EXPIRES_AT: undefined })?.sha, env.BRAI_WEB_PREVIEW_SHA);
  assert.equal(eventsConsumerName(env), "web_preview_1");
  assert.throws(() => eventsConsumerName({ ...env, WEB_EVENTS_CONSUMER: "web_events" }));
  assert.throws(() => eventsConsumerName({ WEB_EVENTS_CONSUMER: "bad.name" }));
  assert.throws(() => previewInfo({ ...env, BRAI_WEB_PREVIEW_SHA: "bad" }));
});
