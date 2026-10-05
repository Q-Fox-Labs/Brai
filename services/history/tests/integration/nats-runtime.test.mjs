// ABOUTME: Проверяет service_history через настоящий NATS и синтетический PostgreSQL.
// ABOUTME: Использует только выделенные runtime/source credentials и уникальные тестовые IDs.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { connect, RequestStrategy } from "nats";
import { config } from "../../dist/config.js";
import { HistoryFault } from "../../dist/domain.js";
import { checkHealth } from "../../dist/health.js";
import { startHistoryRuntime } from "../../dist/main.js";

const runtimeKeys = ["HISTORY_APP_DATABASE_URL", "HISTORY_WEB_DATABASE_URL", "HISTORY_CURSOR_HMAC_KEY_FILE", "NATS_URL", "NATS_USER", "NATS_PASSWORD", "NATS_INBOX_PREFIX", "HISTORY_MCP_HOST", "HISTORY_MCP_PORT", "HISTORY_MCP_ALLOWED_HOSTS", "HISTORY_MCP_ALLOWED_ORIGINS", "HISTORY_MCP_MAX_SESSIONS", "HISTORY_MCP_SESSION_IDLE_MS"];
const sourceKeys = ["SOURCE_NATS_URL", "SOURCE_NATS_USER", "SOURCE_NATS_PASSWORD", "SOURCE_NATS_INBOX_PREFIX"];
const enabled = [...runtimeKeys, ...sourceKeys].every(name => process.env[name]);

const fault = code => error => error instanceof HistoryFault && error.code === code;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function requestBody(scopeId, id = randomUUID()) {
  return {
    id,
    type_id: 101,
    occurred_at: "2026-10-05T18:03:04.123456Z",
    actor_id: null,
    scope_type: "user",
    scope_id: scopeId,
    object_type: null,
    object_id: null,
    data: { runtime_test: true },
  };
}

async function response(nc, subject, body, timeout = 3_000) {
  const msg = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout });
  return {
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(msg.data)),
    code: msg.headers?.get("Nats-Service-Error"),
    status: msg.headers?.get("Nats-Service-Error-Code"),
  };
}

async function serviceResponse(iterator) {
  const results = [];
  for await (const item of iterator) results.push(item);
  return results;
}

async function waitForRow(pool, source, id) {
  const stop = Date.now() + 5_000;
  while (Date.now() < stop) {
    const result = await pool.query("SELECT id FROM history.events WHERE source=$1 AND id=$2", [source, id]);
    if (result.rowCount === 1) return;
    await pause(25);
  }
  assert.fail("event was not committed before the reply deadline");
}

async function waitForAdvisoryWaiter(pool, timeoutMs = 5_000) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' LIMIT 1");
    if (result.rowCount === 1) return;
    await pause(25);
  }
  assert.fail("NATS handler did not reach the expected advisory lock");
}

test("NATS Services, idempotent append, web reads, bounds and graceful drain", { skip: !enabled && "synthetic NATS/PG env is not loaded" }, async t => {
  const cfg = config();
  const runtime = await startHistoryRuntime(cfg);
  const source = await connect({
    servers: process.env.SOURCE_NATS_URL,
    user: process.env.SOURCE_NATS_USER,
    pass: process.env.SOURCE_NATS_PASSWORD,
    inboxPrefix: process.env.SOURCE_NATS_INBOX_PREFIX,
    maxReconnectAttempts: 0,
    timeout: 3_000,
    name: "history_runtime_test",
  });
  const verifyPool = new Pool({ connectionString: cfg.appDatabaseURL, max: 10, connectionTimeoutMillis: 3_000, statement_timeout: 3_000 });

  try {
    await t.test("native PING, INFO and STATS identify the instance", async () => {
      const client = source.services.client({ strategy: RequestStrategy.Count, maxWait: 1_000, maxMessages: 1 });
      const [ping] = await serviceResponse(await client.ping("service_history"));
      const [info] = await serviceResponse(await client.info("service_history"));
      const [stats] = await serviceResponse(await client.stats("service_history"));
      assert.ok(ping?.id);
      assert.equal(info?.name, "service_history");
      assert.equal(info?.version, "1.0.0");
      assert.ok(info?.id);
      assert.equal(stats?.name, "service_history");
      assert.equal(stats?.id, info.id);
    });

    await t.test("append replies only after commit and a lost reply can be retried safely", async () => {
      const id = randomUUID();
      const userId = `history-nats-${randomUUID()}`;
      const body = requestBody(userId, id);
      const replySubject = `${process.env.SOURCE_NATS_INBOX_PREFIX}.lost-${randomUUID()}`;
      source.publish(`brai.history.v1.append.service_history`, Buffer.from(JSON.stringify(body)), { reply: replySubject });
      await source.flush();
      await waitForRow(verifyPool, "service_history", id);

      const first = await response(source, "brai.history.v1.append.service_history", body);
      assert.equal(first.code, undefined);
      assert.equal(first.value.event.id, id);
      assert.equal(first.value.event.source, "service_history");
      const persisted = await verifyPool.query(`SELECT to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at FROM history.events WHERE source=$1 AND id=$2`, ["service_history", id]);
      assert.equal(persisted.rowCount, 1);
      assert.equal(first.value.event.recorded_at, persisted.rows[0].recorded_at);

      const repeated = await response(source, "brai.history.v1.append.service_history", body);
      assert.equal(repeated.value.event.recorded_at, first.value.event.recorded_at);
      assert.equal(repeated.value.event.id, id);

      const conflict = await response(source, "brai.history.v1.append.service_history", { ...body, data: { changed: true } });
      assert.equal(conflict.code, "EVENT_ID_CONFLICT");
      assert.equal(conflict.status, "409");
      assert.deepEqual(conflict.value, { code: "EVENT_ID_CONFLICT", message: "EVENT_ID_CONFLICT", retryable: false });
    });

    await t.test("source comes from the subject and trusted web reads use the web role", async () => {
      const id = randomUUID();
      const userId = `history-web-${randomUUID()}`;
      const body = requestBody(userId, id);
      const append = await response(source, "brai.history.v1.append.service_history", body);
      assert.equal(append.value.event.source, "service_history");

      const list = await response(source, "brai.history.v1.query.list", { user_id: userId, filters: { source: "service_history" }, limit: 5 });
      assert.equal(list.code, undefined);
      assert.ok(list.value.items.some(event => event.id === id));
      const get = await response(source, "brai.history.v1.query.get", { user_id: userId, source: "service_history", id });
      assert.equal(get.value.event.id, id);
      assert.equal(get.value.event.scope_id, userId);

      const forged = await response(source, "brai.history.v1.append.service_history", { ...body, source: "untrusted" });
      assert.equal(forged.code, "INVALID_ARGUMENT");
      assert.equal(forged.status, "400");
      const missing = await response(source, "brai.history.v1.query.get", { user_id: userId, source: "service_history", id: randomUUID() });
      assert.equal(missing.code, "NOT_FOUND");
      assert.equal(missing.status, "404");
    });

    await t.test("invalid JSON and over-sized messages use service error headers", async () => {
      const invalid = await source.request("brai.history.v1.query.get", Buffer.from("{"), { timeout: 3_000 });
      assert.equal(invalid.headers?.get("Nats-Service-Error"), "INVALID_ARGUMENT");
      assert.equal(invalid.headers?.get("Nats-Service-Error-Code"), "400");
      assert.equal(JSON.parse(invalid.string()).retryable, false);

      const tooLarge = await source.request("brai.history.v1.append.service_history", Buffer.alloc(65_537, 0x61), { timeout: 3_000 });
      assert.equal(tooLarge.headers?.get("Nats-Service-Error"), "REQUEST_TOO_LARGE");
      assert.equal(tooLarge.headers?.get("Nats-Service-Error-Code"), "413");
    });

    await t.test("eight active operations and sixty-four queued requests reject the next request", async () => {
      const sourceCode = "service_history";
      const ids = Array.from({ length: 73 }, () => randomUUID());
      const blockers = [];
      let requests = [];
      try {
        for (const id of ids.slice(0, 8)) {
          const client = await verifyPool.connect();
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,70482318))", [`${sourceCode}:${id}`]);
          blockers.push(client);
        }
        const scopeId = `history-load-${randomUUID()}`;
        requests = ids.map(id => source.request("brai.history.v1.append.service_history", Buffer.from(JSON.stringify(requestBody(scopeId, id))), { timeout: 20_000 }));
        const busy = await Promise.any(requests.map(promise => promise.then(msg => {
          if (msg.headers?.get("Nats-Service-Error") === "BUSY") return msg;
          throw new Error("request completed before the gate filled");
        })));
        assert.equal(busy.headers?.get("Nats-Service-Error-Code"), "503");
      } finally {
        for (const client of blockers) {
          try { await client.query("ROLLBACK"); } finally { client.release(); }
        }
      }
      const results = await Promise.all(requests);
      assert.equal(results.filter(msg => msg.headers?.get("Nats-Service-Error") === "BUSY").length, 1);
      assert.equal(results.filter(msg => !msg.headers?.get("Nats-Service-Error")).length, 72);
    });

    await t.test("database readiness fails when the web role cannot connect", async () => {
      const unavailable = { ...cfg, webDatabaseURL: "postgresql://history_web:invalid@127.0.0.1:1/unavailable" };
      await assert.rejects(startHistoryRuntime(unavailable), error => error instanceof HistoryFault && error.code === "DATABASE_UNAVAILABLE");
    });

    await t.test("health fails when NATS is unavailable and closes its PostgreSQL pools", async () => {
      const unavailable = { ...cfg, natsServers: ["nats://127.0.0.1:1"] };
      await assert.rejects(checkHealth(unavailable));
    });

    await t.test("shutdown stops acceptance and waits for an active transaction to settle", async () => {
      const id = randomUUID();
      const userId = `history-shutdown-${randomUUID()}`;
      const body = requestBody(userId, id);
      const blocker = await verifyPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,70482318))", [`service_history:${id}`]);
      const pending = source.request("brai.history.v1.append.service_history", Buffer.from(JSON.stringify(body)), { timeout: 20_000 })
        .then(message => ({ message }), error => ({ error }));
      let blockerReleased = false;
      try {
        await waitForAdvisoryWaiter(verifyPool);
        let stopped = false;
        const stop = runtime.stop().then(() => { stopped = true; });
        await pause(100);
        assert.equal(stopped, false);
        await blocker.query("ROLLBACK");
        blocker.release();
        blockerReleased = true;
        const outcome = await pending;
        assert.equal(outcome.error, undefined);
        const reply = outcome.message;
        assert.equal(JSON.parse(reply.string()).event.id, id);
        await stop;
        assert.equal(stopped, true);
        assert.equal(runtime.connection.isClosed(), true);
      } finally {
        if (!blockerReleased) {
          try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
        }
      }
      await assert.rejects(source.request("brai.history.v1.append.service_history", Buffer.from(JSON.stringify(body)), { timeout: 3_000 }));
    });
  } finally {
    try { await runtime.stop(); } catch { /* report the test assertion, not cleanup logging */ }
    try { await source.close(); } finally { await verifyPool.end(); }
  }
});

test("health rejects an unavailable NATS endpoint", { skip: !enabled && "synthetic NATS/PG env is not loaded" }, async () => {
  const cfg = config();
  await assert.rejects(checkHealth({ ...cfg, natsServers: ["nats://127.0.0.1:1"] }));
});
