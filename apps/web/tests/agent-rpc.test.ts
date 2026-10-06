// ABOUTME: Проверяет срок внешнего Agent RPC и неизвестный исход потерянного ответа.
// ABOUTME: Исполняет настоящий web адаптер с NATS портом; мутации не повторяются.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { Command, ErrorResponse } from "@brai/agent/contracts";
const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
type Reply = { data: Uint8Array; headers?: { get(name: string): string | undefined } };
type RequestPort = (subject: string, data: Uint8Array, options: { timeout: number }) => Promise<Reply>;
function adapter(request: RequestPort, unavailable = false) {
  const source = readFileSync(new URL("../server/agent-http.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { rpc(command: Command): Promise<unknown> } };
  const ports: Record<string, unknown> = { "./auth": {}, "../lib/agent/stream": {}, "./gateway": { GatewayError: class extends Error {}, natsConnection: async () => { if (unavailable) throw new Error("offline"); return { request }; } } };
  new Function("require", "module", "exports", compiled)((name: string) => ports[name] ?? require(name), module, module.exports);
  return module.exports.rpc;
}
function failureBody(error: unknown): ErrorResponse {
  assert.ok(error instanceof Error && "body" in error);
  return error.body as ErrorResponse;
}
const command: Command = { action: "start", ownerId: "owner", projectId: "project", threadId: "thread", generation: "generation", operationId: "operation", text: "synthetic" };

test("delayed native acceptance beyond ten seconds reaches web without a false unknown or resend", { timeout: 15000 }, async () => {
  let sends = 0, deadline = 0;
  const rpc = adapter(async (_subject, bytes, options) => {
    sends++; deadline = options.timeout;
    assert.equal(JSON.parse(Buffer.from(bytes).toString()).operationId, command.operationId);
    return new Promise<Reply>((resolve, reject) => {
      const timeout = setTimeout(() => { clearTimeout(ack); reject(new Error("NATS_TIMEOUT")); }, options.timeout);
      const ack = setTimeout(() => { clearTimeout(timeout); resolve({ data: Buffer.from(JSON.stringify({ outcome: "accepted", operationId: command.operationId })) }); }, 11000);
    });
  });
  assert.deepEqual(await rpc(command), { outcome: "accepted", operationId: command.operationId });
  assert.equal(deadline, 90000);
  assert.equal(sends, 1);
});

test("read deadline stays ten seconds; reply loss remains unknown and offline send stays not-sent", async () => {
  let sends = 0;
  const read = adapter(async (_subject, _bytes, options) => { assert.equal(options.timeout, 10000); return { data: Buffer.from("{}") }; });
  assert.deepEqual(await read({ action: "status" }), {});
  const lost = adapter(async () => { sends++; throw new Error("reply lost"); });
  await assert.rejects(lost(command), (error: unknown) => { const body = failureBody(error); return body.code === "OUTCOME_UNKNOWN" && body.outcome === "unknown"; });
  assert.equal(sends, 1);
  await assert.rejects(adapter(async () => assert.fail("must not send"), true)(command), (error: unknown) => failureBody(error).outcome === "not-sent");
});
