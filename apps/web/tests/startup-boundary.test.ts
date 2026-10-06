// ABOUTME: Проверяет ранний HTML корневой заставки до гидратации любых дочерних страниц.
// ABOUTME: Исполняет настоящие layout и startup компоненты, заменяет только шрифты и CSS imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const cache = new Map<string, Record<string, unknown>>();
function load(path: string): Record<string, unknown> {
  if (cache.has(path)) return cache.get(path)!;
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", output)((name: string) => {
    if (name.endsWith(".css")) return {};
    if (name.startsWith("geist/font/")) return { GeistMono: { variable: "mono" }, GeistSans: { variable: "sans" } };
    if (name.endsWith("app-startup-boundary")) return load("../app/shell/app-startup-boundary.tsx");
    if (name === "./app-startup-splash") return load("../app/shell/app-startup-splash.tsx");
    if (name === "@/components/ui/glare-hover") return load("../components/ui/glare-hover.tsx");
    return require(name);
  }, module, module.exports);
  cache.set(path, module.exports);
  return module.exports;
}

test("root layout covers an arbitrary future page before JavaScript without page-specific splash", () => {
  const Layout = load("../app/layout.tsx").default as ComponentType<{ children: ReactNode }>;
  const html = renderToStaticMarkup(createElement(Layout, null, createElement("main", null, createElement("button", null, "Future page"))));
  assert.ok(html.includes('data-startup-splash="true"'));
  assert.ok(html.includes('/brand/brai-logo-transparent.svg'));
  assert.ok(html.includes('data-startup-content="true"'));
  assert.ok(html.includes('visibility:hidden'));
  assert.ok(html.includes('inert=""'));
  assert.ok(html.includes('aria-hidden="true"'));
  assert.ok(html.includes('Future page'), "children still mount and can measure beneath the overlay");
  assert.ok(html.includes('window.__braiStartupStartedAt=performance.now()'));
  assert.ok(!html.includes('Проверяем вход'));
});

test("counter renders its actual digits before hydration and measurement", () => {
  const SlidingNumber = load("../components/ui/sliding-number.tsx").SlidingNumber as ComponentType<{ value: number; padStart?: boolean }>;
  for (const [value, expected] of [[0, "00"], [12, "12"], [59, "59"]] as const) {
    const html = renderToStaticMarkup(createElement(SlidingNumber, { value, padStart: true }));
    const digits = [...html.matchAll(/<span class="absolute inset-0 flex items-center justify-center">(\d)<\/span>/g)].map(match => match[1]).join("");
    assert.equal(digits, expected);
  }
});
