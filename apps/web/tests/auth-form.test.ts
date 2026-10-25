// ABOUTME: Проверяет операции формы входа через настоящую реализацию Account.
// ABOUTME: Подменяет React hooks и HTTP; реальные письма и сессии не создаются.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const filename = new URL("../app/account.tsx", import.meta.url);
const require = createRequire(filename);
const source = readFileSync(filename, "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
class AuthRequestError extends Error {}
const AuthScreen = Symbol("AuthScreen");
const hooks = {
 useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
 useRef: (current: unknown) => ({ current }),
 useCallback: (callback: unknown) => callback,
 useEffect: () => {},
};
function formOperations() {
 const module = { exports: {} as { default: (props: unknown) => { type: (props: unknown) => { type: unknown; props: { onRequestOtp: (email: string) => Promise<unknown>; onVerifyOtp: (email: string, otp: string) => Promise<void> } }; props: unknown } } };
 new Function("require", "module", "exports", compiled)((name: string) => {
  if (name === "react") return hooks;
  if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
  if (name === "next/navigation") return { usePathname: () => "/auth" };
  if (name === "./auth/screen") return { AuthScreen, AuthRequestError };
  if (name.endsWith(".css")) return {};
  if (name.startsWith("./") || name.startsWith("@/")) return {};
  return require(name);
 }, module, module.exports);
 const account = module.exports.default({ initialSession: { status: "anonymous" } });
 const form = account.type(account.props);
 assert.equal(form.type, AuthScreen);
 return form.props;
}

test("accepted code is not consumed again when session temporarily fails and the user retries", async () => {
 const originalFetch = globalThis.fetch;
 const calls: string[] = [];
 let unavailable = true;
 globalThis.fetch = async (input, init) => {
  const url = String(input); calls.push(url);
  if (url.endsWith("verify-code")) {
   assert.deepEqual(JSON.parse(String(init?.body)), { email: "synthetic@example.test", otp: "001234" });
   return Response.json({ success: true });
  }
  if (url.endsWith("session")) return unavailable ? Response.json({}, { status: 503 }) : Response.json({ user: { id: "fixture", email: "synthetic@example.test" } });
  return Response.json({ success: true });
 };
 try {
  const form = formOperations();
  await assert.rejects(form.onVerifyOtp("synthetic@example.test", "001234"), error => error instanceof AuthRequestError && error.message.startsWith("Код принят."));
  assert.deepEqual(calls, ["/api/auth/verify-code", "/api/auth/session"]);
  unavailable = false;
  await form.onVerifyOtp("synthetic@example.test", "001234");
  assert.equal(calls.filter(url => url.endsWith("verify-code")).length, 1, "accepted code is never verified twice");
  assert.deepEqual(await form.onRequestOtp("synthetic@example.test"), { expires_in_seconds: 300, resend_after_seconds: 60, resend_strategy: "replace" });
  await form.onVerifyOtp("synthetic@example.test", "001234");
  assert.equal(calls.filter(url => url.endsWith("verify-code")).length, 2, "fresh send permits verification again");
 } finally { globalThis.fetch = originalFetch; }
});

test("auth failures distinguish invalid, expired, exhausted and unavailable codes without retrying verify", async () => {
 const originalFetch = globalThis.fetch;
 try {
  for (const [status, code, message] of [
   [400, "INVALID_OTP", "Код не подошёл или уже использован"],
   [400, "OTP_EXPIRED", "Срок действия кода истёк"],
   [403, "TOO_MANY_ATTEMPTS", "Попытки для этого кода исчерпаны. Запросите новый код."],
   [429, undefined, "Слишком много попыток"],
   [503, "AUTH_UNAVAILABLE", "Сервис входа временно недоступен"],
   [500, "INVALID_OTP", "Сервис входа временно недоступен"],
   [403, "INVALID_ORIGIN", "Не удалось проверить код"],
   [400, "UNRECOGNIZED", "Не удалось проверить код"],
  ] as const) {
   const calls: string[] = [];
   globalThis.fetch = async input => { calls.push(String(input)); return Response.json({ code }, { status }); };
   await assert.rejects(formOperations().onVerifyOtp("synthetic@example.test", "001234"), error => error instanceof AuthRequestError && error.message.startsWith(message));
   assert.deepEqual(calls, ["/api/auth/verify-code"]);
  }
  for (const body of ["upstream unavailable", "null"]) {
   globalThis.fetch = async () => new Response(body, { status: 503 });
   await assert.rejects(formOperations().onVerifyOtp("synthetic@example.test", "001234"), /Сервис входа временно недоступен/);
  }
 } finally { globalThis.fetch = originalFetch; }
});


test("unknown verify outcome and network loss recover only through session until a new code is sent", async () => {
 const originalFetch = globalThis.fetch;
 try {
  for (const networkLoss of [false, true]) {
   const calls: string[] = [];
   let available = false;
   globalThis.fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith("verify-code")) {
     if (networkLoss) throw new Error("connection lost");
     return Response.json({code:"AUTH_OUTCOME_UNKNOWN"},{status:503});
    }
    return available ? Response.json({user:{id:"fixture",email:"synthetic@example.test"}}) : Response.json({}, {status:503});
   };
   const form = formOperations();
   await assert.rejects(form.onVerifyOtp("synthetic@example.test", "001234"), /Результат входа уточняется/);
   await assert.rejects(form.onVerifyOtp("synthetic@example.test", "001234"), /Результат входа уточняется/);
   available = true;
   await form.onVerifyOtp("synthetic@example.test", "001234");
   assert.equal(calls.filter(url => url.endsWith("verify-code")).length, 1);
   assert.equal(calls.filter(url => url.endsWith("session")).length, 3);
  }
 } finally { globalThis.fetch = originalFetch; }
});


test("accepted code with absent or different-account session never triggers another verify", async () => {
 const originalFetch = globalThis.fetch;
 try {
  for (const sessionReply of [() => Response.json({}, {status:401}), () => Response.json({user:{id:"other",email:"other@example.test"}})]) {
   let verifies = 0;
   globalThis.fetch = async input => {
    if (String(input).endsWith("verify-code")) { verifies++; return Response.json({success:true}); }
    if (String(input).endsWith("send-code")) return Response.json({}, {status:503});
    return sessionReply();
   };
   const form = formOperations();
   await assert.rejects(form.onVerifyOtp("synthetic@example.test", "001234"), /Код принят/);
   await assert.rejects(form.onRequestOtp("synthetic@example.test"), /Сервис входа временно недоступен/);
   await assert.rejects(form.onVerifyOtp("synthetic@example.test", "001234"), /Код принят/);
   assert.equal(verifies, 1, "failed resend cannot reactivate a consumed code");
  }
 } finally { globalThis.fetch = originalFetch; }
});
