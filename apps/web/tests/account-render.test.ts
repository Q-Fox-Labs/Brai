// ABOUTME: Проверяет первый HTML аккаунта до выполнения браузерных эффектов.
// ABOUTME: Подменяет дочерние экраны и контролы; состояние входа берёт из настоящего Account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { AccountSession } from "../server/account-session.ts";

const filename = new URL("../app/account.tsx", import.meta.url);
const source = readFileSync(filename, "utf8");
const require = createRequire(filename);
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { default: ComponentType<{ initialSession: AccountSession; agentMode?: "dev_agent" | "hermes_telegram"; telegramBotUsername?: string | null }> } };
const control = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
const screen = () => createElement("main", null, "workspace content");
new Function("require", "module", "exports", output)((name: string) => {
  if (name.endsWith(".css")) return {};
  if (name === "next/navigation") return { usePathname: () => "/agent" };
  if (name === "./alerts/provider") return { AlertsProvider: control };
  if (name === "./auth/screen") return { AuthScreen: () => createElement("main", null, "Вход в Brai"), AuthRequestError: Error };
  if (name === "./shell/login-galaxy") return { LoginGalaxy: control };
  if (name.startsWith("@/components/ui/")) return new Proxy({}, { get: () => control });
  if (name === "./agent/screen") return { default: () => createElement("main", null, "DEV Agent client") };
  if (name === "./agent/telegram-entry") return { default: () => createElement("main", null, "Telegram entry") };
  if (name.startsWith("./")) return { default: screen };
  return require(name);
}, module, module.exports);

test("verified session renders workspace on first HTML without a client auth request", () => {
  const html = renderToStaticMarkup(createElement(module.exports.default, { initialSession: { status: "authenticated", user: { id: "owner", email: "owner@example.test" } } }));
  assert.ok(html.includes("workspace-content"));
  assert.ok(html.includes("workspace content"));
  assert.ok(html.includes("DEV Agent client"));
  assert.ok(!html.includes("Вход в Brai"));
  assert.ok(!html.includes("Проверяем вход"));
});

test("anonymous document renders login immediately; auth outage renders retry without a false logout", () => {
  const login = renderToStaticMarkup(createElement(module.exports.default, { initialSession: { status: "anonymous" } }));
  assert.ok(login.includes("Вход в Brai"));
  assert.ok(!login.includes("Проверяем вход"));
  const offline = renderToStaticMarkup(createElement(module.exports.default, { initialSession: { status: "unavailable" } }));
  assert.ok(offline.includes("Повторить подключение"));
  assert.ok(!offline.includes("Вход в Brai"));
  assert.ok(!offline.includes("workspace-content"));
});

test("Hermes mode replaces the DEV Agent screen with the Telegram workspace entry", () => {
  const html = renderToStaticMarkup(createElement(module.exports.default, {
    initialSession: { status: "authenticated", user: { id: "owner", email: "owner@example.test" } },
    agentMode: "hermes_telegram",
    telegramBotUsername: "brai_hermes_bot",
  }));
  assert.ok(html.includes("Telegram entry"));
  assert.ok(!html.includes("DEV Agent client"));
});
