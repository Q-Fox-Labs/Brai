// ABOUTME: Проверяет обязательные адреса, allowlists и пределы MCP-конфигурации.
// ABOUTME: Читатель ключа подменён тестовыми байтами; секреты не выводятся.
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../dist/config.js";

const env = () => ({
  HISTORY_APP_DATABASE_URL: "postgresql://history_app:synthetic@127.0.0.1:15479/brai_history_test",
  HISTORY_WEB_DATABASE_URL: "postgresql://history_web:synthetic@127.0.0.1:15479/brai_history_test",
  HISTORY_CURSOR_HMAC_KEY_FILE: "/fixture/cursor-key",
  NATS_URL: "nats://127.0.0.1:14279",
  NATS_USER: "history-runtime",
  NATS_PASSWORD: "synthetic-runtime-password",
  NATS_INBOX_PREFIX: "_INBOX.brai_history",
  HISTORY_MCP_HOST: "127.0.0.1",
  HISTORY_MCP_PORT: "19340",
  HISTORY_MCP_ALLOWED_HOSTS: "localhost:19340,127.0.0.1:19340",
  HISTORY_MCP_ALLOWED_ORIGINS: "http://localhost:19340,http://127.0.0.1:19340",
  HISTORY_MCP_MAX_SESSIONS: "64",
  HISTORY_MCP_SESSION_IDLE_MS: "300000",
});

test("requires explicit DB, NATS, cursor and MCP configuration", () => {
  const values = env();
  const loaded = config(values, () => Buffer.alloc(32, 7));
  assert.equal(loaded.natsInboxPrefix, "_INBOX.brai_history");
  assert.deepEqual(loaded.natsServers, ["nats://127.0.0.1:14279"]);
  assert.equal(loaded.mcpPort, 19340);
  assert.equal(loaded.mcpMaxSessions, 64);
  assert.equal(loaded.cursorKey.byteLength, 32);

  delete values.HISTORY_WEB_DATABASE_URL;
  assert.throws(() => config(values, () => Buffer.alloc(32, 7)), /MISSING_HISTORY_WEB_DATABASE_URL/);
});

test("rejects invalid ports, origins and short cursor keys", () => {
  const values = env();
  values.HISTORY_MCP_PORT = "65536";
  assert.throws(() => config(values, () => Buffer.alloc(32, 7)), /INVALID_HISTORY_MCP_PORT/);
  values.HISTORY_MCP_PORT = "19340";
  values.HISTORY_MCP_ALLOWED_ORIGINS = "http://localhost:19340/path";
  assert.throws(() => config(values, () => Buffer.alloc(32, 7)), /INVALID_HISTORY_MCP_ALLOWED_ORIGINS/);
  values.HISTORY_MCP_ALLOWED_ORIGINS = "http://localhost:19340";
  assert.throws(() => config(values, () => Buffer.alloc(31, 7)), /HISTORY_CURSOR_KEY_TOO_SHORT/);
  values.NATS_INBOX_PREFIX = "_INBOX.brai_history_source.>";
  assert.throws(() => config(values, () => Buffer.alloc(32, 7)), /INVALID_NATS_INBOX_PREFIX/);
  values.NATS_INBOX_PREFIX = "_INBOX.brai_history_source";
  assert.equal(config(values, () => Buffer.alloc(32, 7)).natsInboxPrefix, "_INBOX.brai_history_source");
});
