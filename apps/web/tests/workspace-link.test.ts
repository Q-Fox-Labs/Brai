// ABOUTME: Проверяет локальные переходы оболочки и стандартное поведение ссылок.
// ABOUTME: Изолирует History API; интеграцию с Next проверяют в браузере.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../app/shell/workspace-link.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { default: (props: Record<string, unknown>) => { props: { onClick: (event: Record<string, unknown>) => void } } } };
const paths: string[] = [];
const browser = { location: { pathname: "/" }, history: { pushState: (_state: unknown, _unused: string, path: string) => { paths.push(path); browser.location.pathname = path; } } };
new Function("require", "module", "exports", "window", compiled)(require, module, module.exports, browser);

test("workspace click changes address once; current section keeps its history entry", () => {
  paths.length = 0; browser.location.pathname = "/";
  const link = module.exports.default({ href: "/agent" });
  let prevented = 0;
  const click = { button: 0, preventDefault: () => { prevented++; } };
  link.props.onClick(click); link.props.onClick(click);
  assert.deepEqual(paths, ["/agent"]);
  assert.equal(prevented, 2);
});

test("modified, cancelled, download and new-tab clicks retain native link behavior", () => {
  paths.length = 0; browser.location.pathname = "/";
  for (const event of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    module.exports.default({ href: "/do" }).props.onClick({ button: 0, preventDefault: () => assert.fail("native click intercepted"), ...event });
  }
  for (const props of [{ target: "_blank" }, { download: "" }]) {
    module.exports.default({ href: "/do", ...props }).props.onClick({ button: 0, preventDefault: () => assert.fail("native click intercepted") });
  }
  const event = { button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  module.exports.default({ href: "/do", onClick: (value: typeof event) => value.preventDefault() }).props.onClick(event);
  assert.deepEqual(paths, []);
});
