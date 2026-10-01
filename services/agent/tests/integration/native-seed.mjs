// ABOUTME: Создаёт один собственный native seed для live service и browser проверок.
// ABOUTME: Удерживает исходный RPC; не создаёт NATS consumer и не меняет переданный cwd.

import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { createCodex } from "../../dist/codex.js";

const methods = {
  question: "item/tool/requestUserInput",
  "command-approval": "item/commandExecution/requestApproval",
  "file-change-approval": "item/fileChange/requestApproval",
  permissions: "item/permissions/requestApproval",
};

/** Точные native recipes; permissions включает только разрешённый thread-scoped feature. */
export function nativeSeedRecipe(kind, cwd, ephemeral = false) {
  const prompts = {
    question: "Use request_user_input now to ask which test label to choose, options Alpha and Beta. Do not answer the question yourself. After the answer reply BRAI_FORM_DONE. Do not use any other tools.",
    "command-approval": "Use exec_command to run exactly `printf BRAI_APPROVAL_OK` with sandbox_permissions=require_escalated and justification='Approve the synthetic printf test'. Wait for user approval; do not replace it with an unapproved command. After execution reply BRAI_FORM_DONE.",
    "file-change-approval": "Use apply_patch to add seed-form.txt containing BRAI_FILE_APPROVAL_OK in the current directory. The sandbox is read-only: request the native file-change approval and wait for the user. Do not use shell commands or write outside this directory. Then reply BRAI_FORM_DONE.",
    permissions: `Use request_permissions now to request filesystem write access ONLY to ${cwd} for this turn. Do not use exec_command or other tools. Wait for the user response, then reply BRAI_FORM_DONE.`,
  };
  assert.ok(methods[kind], "unsupported native seed kind");
  return {
    kind, prompt: `${prompts[kind]} Do not delegate or spawn subagents. Only gpt-6.1-sol is permitted; all other models and any model fallback are forbidden.`,
    threadSettings: {
      model: "gpt-6.1-sol", allowProviderModelFallback: false,
      ephemeral, approvalsReviewer: "user", approvalPolicy: "on-request", sandbox: "read-only",
      ...(kind === "permissions" ? { config: { "features.request_permissions_tool": true } } : {}),
    },
    turnSettings: kind === "question" ? {
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "medium", developer_instructions: null } },
    } : {},
  };
}

/** Открывает только own cwd/thread; caller обязан вызвать releaseNativeSeed даже после ошибки проверки. */
export async function createNativeSeed({ socketUrl, cwd, projectId, kind, prompt, ephemeral = false, timeoutMs = 90000, onThreadCreated, signal }) {
  assert.ok(isAbsolute(cwd), "absolute own fixture cwd required");
  assert.ok(socketUrl.startsWith("ws+unix:"), "existing native socket required");
  const recipe = nativeSeedRecipe(kind, cwd, ephemeral);
  const seed = { projectId, cwd, kind, recipe, ephemeral, threadId: null, turnId: null, rawRequestId: null, params: null, terminal: null, turnAttempted: false, turnNotSent: false, released: false, port: createCodex({ socketUrl }), observations: [] };
  let bytes = 0;
  const waiters = new Set();
  seed.wait = (predicate, maximum = timeoutMs) => {
    const found = seed.observations.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(Object.assign(new Error(`native ${kind} capability not observed within ${maximum}ms`), { code: "NATIVE_CAPABILITY_NOT_OBSERVED" })); }, maximum);
      waiters.add(waiter);
    });
  };
  seed.unsubscribeObserver = seed.port.subscribe((event) => {
    if (event.type === "notification" && event.params.threadId === seed.threadId) {
      if (event.method === "turn/started" && !seed.turnId) seed.turnId = event.params.turn.id;
      if (event.method === "turn/completed" && event.params.turn.id === seed.turnId) seed.terminal = event.params.turn;
    }
    const size = Buffer.byteLength(JSON.stringify(event));
    if (seed.observations.length < 320 && bytes + size < 1024 * 1024) { seed.observations.push(event); bytes += size; }
    for (const waiter of waiters) if (waiter.predicate(event)) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(event);
    }
  });
  seed.cancelWaiters = () => { for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error("native seed released")); } waiters.clear(); };
  const onAbort = () => {
    seed.cancelWaiters();
    if (seed.ready) {
      seed.abortCleanup = releaseNativeSeed(seed);
      void seed.abortCleanup.catch((error) => { seed.abortCleanupError = error; });
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  seed.removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
  try {
    signal?.throwIfAborted();
    await seed.port.connect();
    signal?.throwIfAborted();
    const started = await seed.port.call("thread/start", { cwd, ...recipe.threadSettings }, { mutation: true });
    seed.threadId = started.thread.id;
    assert.equal(started.model, "gpt-6.1-sol");
    await onThreadCreated?.({ projectId, cwd, threadId: seed.threadId, ephemeral, model: started.model });
    signal?.throwIfAborted();
    seed.turnAttempted = true;
    let turn;
    try { turn = await seed.port.call("turn/start", { threadId: seed.threadId, input: [{ type: "text", text: prompt ?? recipe.prompt }], ...recipe.turnSettings }, { mutation: true }); }
    catch (error) { seed.turnNotSent = error.outcome === "not-sent"; throw error; }
    assert.ok(seed.turnId === null || seed.turnId === turn.turn.id, "turn/start response differs from the first own native turn identity");
    seed.turnId ??= turn.turn.id;
    const alreadyCompleted = seed.observations.find((event) => event.type === "notification" && event.method === "turn/completed" && event.params.threadId === seed.threadId && event.params.turn.id === seed.turnId);
    if (alreadyCompleted) seed.terminal = alreadyCompleted.params.turn;
    signal?.throwIfAborted();
    const request = await seed.wait((event) => event.type === "request" && event.method === methods[kind] && event.params.threadId === seed.threadId && event.params.turnId === seed.turnId);
    assert.equal(request.supported, true, "native form is outside the supported runtime schema");
    seed.rawRequestId = request.id;
    seed.params = request.params;
    /** Подтверждает исходный native RPC после ответа другого клиента, сохраняя тип ID. */
    seed.waitResolved = (maximum = 30000) => seed.wait((event) => event.type === "notification" && event.method === "serverRequest/resolved" && event.params.threadId === seed.threadId && event.params.requestId === seed.rawRequestId, maximum);
    signal?.throwIfAborted();
    seed.ready = true;
    return seed;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("native seed preparation failed", { cause });
    try { await releaseNativeSeed(seed); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "native seed failed and terminal cleanup could not be confirmed"); }
    error.nativeEvidence = { kind, threadId: seed.threadId, turnId: seed.turnId, terminalStatus: seed.terminal?.status, ephemeral, released: seed.released };
    throw error;
  }
}

/** Подтверждает terminal до unsubscribe/close. Не удаляет cwd, не повторяет мутации. */
export async function releaseNativeSeed(seed) {
  if (seed.released) return;
  if (seed.releasePromise) return seed.releasePromise;
  seed.releasePromise = release(seed);
  return seed.releasePromise;
}

async function release(seed) {
  seed.removeAbortListener();
  try {
    if (seed.threadId && !seed.terminal) {
      if (!seed.turnAttempted || seed.turnNotSent) seed.terminal = { status: "no-turn-sent" };
      else {
        if (!seed.turnId) {
          await seed.wait((event) => event.type === "notification" && event.method === "turn/started" && event.params.threadId === seed.threadId, 15000);
        }
        assert.ok(seed.turnId, "unknown turn/start outcome requires own native turn identity");
        try { await seed.port.call("turn/interrupt", { threadId: seed.threadId, turnId: seed.turnId }, { mutation: true }); } catch { /* Acceptance is not terminal proof. */ }
        await seed.wait((event) => event.type === "notification" && event.method === "turn/completed" && event.params.threadId === seed.threadId && event.params.turn.id === seed.turnId, 30000);
      }
    }
    if (seed.threadId) {
      assert.ok(seed.terminal, "terminal confirmation required before native unsubscribe");
      const result = await seed.port.call("thread/unsubscribe", { threadId: seed.threadId }, { mutation: true });
      assert.ok(["notLoaded", "notSubscribed", "unsubscribed"].includes(result.status), "native unsubscribe was not confirmed");
    }
    seed.released = true;
  } finally {
    seed.removeAbortListener();
    seed.cancelWaiters(); seed.unsubscribeObserver(); await seed.port.close();
  }
}
