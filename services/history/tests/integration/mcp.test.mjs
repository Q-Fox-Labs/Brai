// ABOUTME: Проверяет настоящий MCP Streamable HTTP, SDK client и PostgreSQL fixture.
// ABOUTME: Использует только синтетические строки и не очищает общую схему истории.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../../dist/config.js";
import { startHistoryRuntime } from "../../dist/main.js";
import { startMcp } from "../../dist/mcp.js";

const runtimeKeys = ["HISTORY_APP_DATABASE_URL", "HISTORY_WEB_DATABASE_URL", "HISTORY_CURSOR_HMAC_KEY_FILE", "NATS_URL", "NATS_USER", "NATS_PASSWORD", "NATS_INBOX_PREFIX", "HISTORY_MCP_HOST", "HISTORY_MCP_PORT", "HISTORY_MCP_ALLOWED_HOSTS", "HISTORY_MCP_ALLOWED_ORIGINS", "HISTORY_MCP_MAX_SESSIONS", "HISTORY_MCP_SESSION_IDLE_MS"];
const enabled = runtimeKeys.every(name => process.env[name]);
const limit = 524_288;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function rawRequest(url, { host, origin, body = "{}", sessionId }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        host,
        ...(origin === undefined ? {} : { origin }),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        accept: "application/json, text/event-stream",
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks).byteLength }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function heldInitialize(url) {
  const target = new URL(url);
  const request = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      host: target.host,
      origin: `http://${target.host}`,
      "content-type": "application/json",
      "content-length": 256,
      accept: "application/json, text/event-stream",
    },
  });
  const response = new Promise((resolve, reject) => {
    request.once("response", value => resolve(value.statusCode));
    request.once("error", reject);
  });
  response.catch(() => {});
  request.write('{"jsonrpc":"2.0","id":1,"method":"initialize"');
  return { request, response };
}

function slowSessionPost(url, { host, origin, sessionId, body, delayMs }) {
  const target = new URL(url);
  const encoded = Buffer.from(body);
  const split = Math.max(1, Math.floor(encoded.byteLength / 2));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        host,
        origin,
        "mcp-session-id": sessionId,
        "content-type": "application/json",
        "content-length": encoded.byteLength,
        accept: "application/json, text/event-stream",
      },
    }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.write(encoded.subarray(0, split));
    setTimeout(() => request.end(encoded.subarray(split)), delayMs);
  });
}

async function connectClient(url, observedBodies = []) {
  const client = new Client({ name: "history-mcp-integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (response.headers.get("content-type")?.includes("application/json")) {
        observedBodies.push(Buffer.from(await response.clone().arrayBuffer()).byteLength);
      }
      return response;
    },
  });
  await client.connect(transport);
  return { client, transport };
}

test("official MCP client lists and calls all tools, resources, and bounded HTTP lifecycle", { skip: !enabled && "dedicated synthetic PostgreSQL/NATS env is not loaded" }, async t => {
  const base = config();
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const cfg = { ...base, mcpHost: "127.0.0.1", mcpPort: port, mcpAllowedHosts: [host], mcpAllowedOrigins: [origin], mcpMaxSessions: 64, mcpSessionIdleMs: 300_000 };
  const runtime = await startHistoryRuntime(cfg);
  const clientBodies = [];
  let client;
  let transport;
  let cappedServer;
  const moreClients = [];
  try {
    ({ client, transport } = await connectClient(runtime.mcp.url, clientBodies));
    await t.test("tools/list exposes exactly ten owner schemas with flattened local refs", async () => {
      const listed = await client.listTools();
      const names = listed.tools.map(tool => tool.name).sort();
      assert.deepEqual(names, ["history_append", "history_categories_list", "history_category_create", "history_category_update", "history_get", "history_search", "history_type_create", "history_type_get", "history_type_update", "history_types_list"].sort());
      for (const tool of listed.tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.outputSchema.type, "object");
        const schemas = JSON.stringify([tool.inputSchema, tool.outputSchema]);
        assert.equal(schemas.includes("$ref"), false, `${tool.name} has an unresolved schema reference`);
        assert.equal(schemas.includes("brai.invalid"), false, `${tool.name} exposes an owner URL`);
      }
    });

    await t.test("resources return the owner contract and actual common event schema", async () => {
      const listed = await client.listResources();
      assert.deepEqual(listed.resources.map(resource => resource.uri).sort(), ["brai://history/CONTRACT.md", "brai://history/schemas/common.schema.json"].sort());
      const contract = await client.readResource({ uri: "brai://history/CONTRACT.md" });
      assert.ok(contract.contents[0].text.includes("Внутренний MCP"));
      const schema = await client.readResource({ uri: "brai://history/schemas/common.schema.json" });
      const value = JSON.parse(schema.contents[0].text);
      assert.equal(value.definitions.event.required.length, 11);
      assert.equal(value.definitions.event.properties.id.$ref, "#/definitions/uuid");
    });

    await t.test("all ten tools use real handlers and audit rows", async () => {
      const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
        assert.ok(result.structuredContent);
        return result.structuredContent;
      };
      const categories = await call("history_categories_list", { limit: 5 });
      assert.ok(Array.isArray(categories.items));
      const types = await call("history_types_list", { limit: 5 });
      assert.ok(types.items.length > 0);
      const existingType = await call("history_type_get", { id: types.items[0].id });
      assert.equal(existingType.type.id, types.items[0].id);

      const suffix = randomUUID().replaceAll("-", "");
      const category = await call("history_category_create", {
        event_id: randomUUID(), code: `mcp_${suffix}`, name: `MCP ${suffix}`, description: "synthetic MCP integration category",
      });
      assert.equal(category.result.code, `mcp_${suffix}`);
      assert.equal(category.audit_event.object_type, "sys_categories");
      const categoryUpdate = await call("history_category_update", {
        event_id: randomUUID(), id: category.result.id, name: `MCP updated ${suffix}`, description: "updated by MCP integration",
      });
      assert.equal(categoryUpdate.result.name, `MCP updated ${suffix}`);

      const type = await call("history_type_create", {
        event_id: randomUUID(), category_id: category.result.id, code: `mcp_${suffix}`, name: `MCP type ${suffix}`, description: "synthetic MCP integration type",
      });
      assert.equal(type.result.category_id, category.result.id);
      const typeUpdate = await call("history_type_update", {
        event_id: randomUUID(), id: type.result.id, name: `MCP type updated ${suffix}`, description: "updated by MCP integration",
      });
      assert.equal(typeUpdate.result.name, `MCP type updated ${suffix}`);

      const id = randomUUID();
      const event = {
        source: `mcp_${suffix}`,
        id,
        type_id: type.result.id,
        occurred_at: "2026-10-05T18:03:04.123456Z",
        actor_id: "agent-claimed",
        scope_type: "user",
        scope_id: `mcp-scope-${suffix}`,
        object_type: null,
        object_id: null,
        data: { integration_test: true },
      };
      const appended = await call("history_append", event);
      assert.equal(appended.event.source, event.source);
      const fetched = await call("history_get", { source: event.source, id });
      assert.equal(fetched.event.id, id);
      const searched = await call("history_search", { filters: { source: event.source, scope_id: event.scope_id }, limit: 10 });
      assert.ok(searched.items.some(item => item.id === id));

      const audit = await call("history_get", { source: "service_history", id: type.audit_event.id });
      assert.equal(audit.event.object_type, "sys_types");
      await assert.rejects(client.callTool({ name: "constructor", arguments: {} }));
      const forged = await client.callTool({ name: "history_append", arguments: {
        ...event, id: randomUUID(), source: "service_history", scope_type: "system", scope_id: "service_history",
        object_type: "sys_types", object_id: String(type.result.id),
      } });
      assert.equal(forged.isError, true);
      assert.equal(JSON.parse(forged.content[0].text).code, "INVALID_ARGUMENT");
    });

    await t.test("MCP pagination budgets the final structured HTTP envelope", async () => {
      const suffix = randomUUID().replaceAll("-", "");
      const source = `mcp_${suffix}`;
      const scopeId = `mcp-large-${suffix}`;
      const types = await client.callTool({ name: "history_types_list", arguments: { limit: 1 } });
      assert.notEqual(types.isError, true);
      const typeId = types.structuredContent.items[0].id;
      const ids = [];
      for (let index = 0; index < 12; index++) {
        const id = randomUUID();
        ids.push(id);
        const result = await client.callTool({ name: "history_append", arguments: {
          source, id, type_id: typeId, occurred_at: "2026-10-05T18:03:04.123456Z", actor_id: null,
          scope_type: "user", scope_id: scopeId, object_type: null, object_id: null,
          data: { payload: "x".repeat(50_000) },
        } });
        assert.notEqual(result.isError, true);
      }
      const observed = [];
      let cursor = null;
      const actual = [];
      do {
        const before = clientBodies.length;
        const result = await client.callTool({ name: "history_search", arguments: { filters: { source, scope_id: scopeId }, limit: 100, ...(cursor ? { cursor } : {}) } });
        assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
        actual.push(...result.structuredContent.items.map(item => item.id));
        cursor = result.structuredContent.next_cursor;
        observed.push(...clientBodies.slice(before));
      } while (cursor);
      assert.deepEqual(actual.sort(), ids.sort());
      assert.ok(observed.length >= 2, "large result pages must split at the shared response budget");
      assert.ok(observed.every(bytes => bytes <= limit), `wire response exceeded ${limit} bytes: ${Math.max(...observed)}`);
    });

    await t.test("Host, Origin, and request body bounds are enforced before MCP parsing", async () => {
      const badHost = await rawRequest(runtime.mcp.url, { host: "untrusted.invalid", origin, body: "x".repeat(70_000) });
      assert.equal(badHost.status, 403);
      const badOrigin = await rawRequest(runtime.mcp.url, { host, origin: "http://untrusted.invalid", body: "{}" });
      assert.equal(badOrigin.status, 403);
      const oversized = await rawRequest(runtime.mcp.url, { host, origin, body: " ".repeat(65_537) });
      assert.equal(oversized.status, 413);
    });

    await t.test("initialization reservations cap concurrent sessions; idle and DELETE release them", async () => {
      const capPort = await freePort();
      const capHost = `127.0.0.1:${capPort}`;
      const capOrigin = `http://${capHost}`;
      const cappedConfig = { ...cfg, mcpPort: capPort, mcpAllowedHosts: [capHost], mcpAllowedOrigins: [capOrigin], mcpMaxSessions: 2, mcpSessionIdleMs: 500 };
      cappedServer = await startMcp(cappedConfig, runtime.handlers, runtime.gate);

      const held = [heldInitialize(cappedServer.url), heldInitialize(cappedServer.url)];
      await pause(100);
      await assert.rejects(connectClient(cappedServer.url));
      for (const pending of held) pending.request.destroy();
      await pause(100);

      const attempts = await Promise.all(Array.from({ length: 8 }, async () => {
        try {
          const connected = await connectClient(cappedServer.url);
          moreClients.push(connected);
          return true;
        } catch {
          return false;
        }
      }));
      assert.equal(attempts.filter(Boolean).length, 2, "only two concurrent initializes may be accepted");

      const idle = moreClients[0];
      const idleSession = idle.transport.sessionId;
      assert.ok(idleSession);
      const delayedResponse = slowSessionPost(cappedServer.url, {
        host: capHost,
        origin: capOrigin,
        sessionId: idleSession,
        body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/list" }),
        delayMs: 800,
      });
      await pause(700);
      assert.equal(await delayedResponse, 200, "an in-flight POST body keeps its session alive across idle sweeps");
      await pause(1_200);
      const expired = await rawRequest(cappedServer.url, {
        host: capHost,
        origin: capOrigin,
        sessionId: idleSession,
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      });
      assert.equal(expired.status, 404);
      const afterIdle = await connectClient(cappedServer.url);
      moreClients.push(afterIdle);
      await afterIdle.transport.terminateSession();
      const afterDelete = await connectClient(cappedServer.url);
      moreClients.push(afterDelete);
      await afterDelete.transport.terminateSession();
    });

    await t.test("client observes the shutdown of its active session", async () => {
      assert.ok(clientBodies.length > 0);
      assert.ok(clientBodies.every(bytes => bytes <= limit), `wire response exceeded ${limit} bytes`);
      await runtime.stop();
      await assert.rejects(client.listTools());
    });
  } finally {
    for (const entry of moreClients) {
      await entry.transport.terminateSession().catch(() => {});
      await entry.client.close().catch(() => {});
    }
    await transport?.terminateSession().catch(() => {});
    await cappedServer?.close().catch(() => {});
    await runtime.stop();
    await client?.close().catch(() => {});
  }
});
