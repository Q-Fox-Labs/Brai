// ABOUTME: Проверяет входные и выходные DTO сервиса истории по owner-схемам.
// ABOUTME: Проверяет границы web/MCP и ссылки AsyncAPI без внешних сервисов.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import AjvImport from "ajv";
import formatsImport from "ajv-formats";
import {
  validateNatsRequest,
  validateNatsResponse,
  validateToolInput,
  validateToolOutput,
} from "../dist/contracts.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "../schemas");
const schemaNames = ["common", "messages", "tools"];
const schemas = await Promise.all(schemaNames.map(async name =>
  JSON.parse(await readFile(resolve(schemaDir, name + ".schema.json"), "utf8"))));
const eventId = "00000000-0000-4000-8000-000000000001";
const event = {
  id: eventId,
  source: "brai_timer",
  type_id: 101,
  occurred_at: "2026-10-05T12:00:00.123456Z",
  recorded_at: "2026-10-05T12:00:00.123456Z",
  actor_id: null,
  scope_type: "user",
  scope_id: "user-1",
  object_type: null,
  object_id: null,
  data: {},
};
const category = { id: 1, code: "object", name: "Объекты", description: "События объектов" };
const type = { id: 101, category_id: 1, code: "create", name: "Создание", description: "Создание записи" };
const toolInputs = {
  history_categories_list: {},
  history_types_list: {},
  history_type_get: { id: 101 },
  history_append: { source: "brai_timer", id: eventId, type_id: 101, occurred_at: event.occurred_at, scope_type: "user", scope_id: "user-1" },
  history_get: { source: "brai_timer", id: eventId },
  history_search: { filters: { scope_type: "user", scope_id: "user-1" } },
  history_category_create: { event_id: eventId, code: "new_category", name: "Категория", description: "", actor_id: null },
  history_category_update: { event_id: eventId, id: 1, name: "Категория", description: "", actor_id: null },
  history_type_create: { event_id: eventId, category_id: 1, code: "new_type", name: "Тип", description: "", actor_id: null },
  history_type_update: { event_id: eventId, id: 101, name: "Тип", description: "", actor_id: null },
};
const mutation = { result: category, audit_event: event };
const toolOutputs = {
  history_categories_list: { items: [category], next_cursor: null },
  history_types_list: { items: [type], next_cursor: null },
  history_type_get: { type },
  history_append: { event },
  history_get: { event },
  history_search: { items: [event], next_cursor: null },
  history_category_create: mutation,
  history_category_update: mutation,
  history_type_create: { result: type, audit_event: event },
  history_type_update: { result: type, audit_event: event },
};

test("все десять инструментов MCP соответствуют входным и выходным схемам", () => {
  assert.deepEqual(Object.keys(toolInputs).sort(), Object.keys(toolOutputs).sort());
  for (const name of Object.keys(toolInputs)) {
    assert.equal(validateToolInput(name, toolInputs[name]), true, name + " input");
    assert.equal(validateToolOutput(name, toolOutputs[name]), true, name + " output");
  }
});

test("web-чтение требует доверенный user_id и запрещает подмену области", () => {
  assert.equal(validateNatsRequest("list", { user_id: "user-1", filters: { source: "brai_timer" } }), true);
  assert.equal(validateNatsRequest("list", { user_id: "user-1", filters: { scope_type: "system" } }), false);
  assert.equal(validateNatsRequest("get", { user_id: "user-1", source: "brai_timer", id: eventId }), true);
  assert.equal(validateToolInput("history_get", { source: "brai_timer", id: eventId }), true);
  assert.equal(validateToolInput("history_get", { source: "brai_timer", id: eventId, user_id: "user-1" }), false);
});

test("схемы событий и ответов сохраняют точную форму и микросекунды", () => {
  assert.equal(validateNatsResponse("append", { event }), true);
  assert.equal(validateNatsResponse("append", { event: { ...event, extra: true } }), false);
  assert.equal(validateNatsResponse("append", { event: { ...event, recorded_at: "2026-10-05T12:00:00.1234567Z" } }), false);
  assert.equal(validateNatsResponse("error", { code: "BUSY", message: "Сервис занят", retryable: true }), true);
  assert.equal(validateNatsResponse("error", { code: "UNKNOWN", message: "Ошибка", retryable: false }), false);
});

test("все ссылки AsyncAPI разрешаются в компилируемые схемы Draft-07", async () => {
  const asyncapi = await readFile(resolve(here, "../asyncapi.yaml"), "utf8");
  const refs = [...asyncapi.matchAll(/\$ref:\s+\.\/schemas\/([^#\s]+\.json)#\/definitions\/([A-Za-z0-9_-]+)/g)];
  assert.equal(refs.length, 8, "AsyncAPI должен публиковать семь DTO и схему параметра source");

  const Ajv = AjvImport.default ?? AjvImport;
  const addFormats = formatsImport.default ?? formatsImport;
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
  for (const [, filename, definition] of refs) {
    const target = schemas.find(schema => schema.$id.endsWith("/" + filename));
    assert.ok(target, "нет файла схемы: " + filename);
    assert.ok(target.definitions[definition], "нет определения схемы: " + filename + "#" + definition);
    assert.doesNotThrow(() => ajv.compile({ $ref: target.$id + "#/definitions/" + definition }), filename + "#" + definition);
  }
});
