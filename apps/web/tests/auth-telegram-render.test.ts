// ABOUTME: Проверяет уведомление о доступе администраторов на форме входа Telegram.
// ABOUTME: Серверный рендер использует синтетические обработчики и подменяет оформление.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const path = new URL("../app/auth/screen.tsx", import.meta.url), require = createRequire(path);
const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { AuthScreen: ComponentType<{ telegramIdentity: boolean; busy: boolean; onRequestOtp: () => Promise<object>; onVerifyOtp: () => Promise<void> }> } };
const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
new Function("require", "module", "exports", output)((name: string) => {
 if (name.endsWith(".css")) return {};
 if (name === "@/components/ui/cn") return { cn: (...values: string[]) => values.join(" ") };
 if (name.startsWith("@/components/ui/") || name === "lucide-react" || name === "../shell/login-galaxy") return new Proxy({}, { get: () => wrapper });
 return require(name);
}, module, module.exports);
test("Telegram login informs users of administrator access before sign-in", () => {
 const html = renderToStaticMarkup(createElement(module.exports.AuthScreen, { telegramIdentity: true, busy: false, onRequestOtp: async () => ({}), onVerifyOtp: async () => {} }));
 assert.match(html, /Администраторы этой установки могут просматривать ваши чаты, память и файлы\./);
});
