// ABOUTME: Проверяет отображение ответов владельцев на административном экране.
// ABOUTME: Использует только вымышленные данные и серверный рендер React.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const path = new URL("../app/admin/detail.tsx", import.meta.url), require = createRequire(path);
const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { AdminDetail: ComponentType<{ value: unknown; view: string; userId: string }> } };
new Function("require", "module", "exports", output)(require, module, module.exports);
test("admin details show real memory, messages and a target-bound download", () => {
 const render = (view: string, value: unknown) => renderToStaticMarkup(createElement(module.exports.AdminDetail, { view, value, userId: "user-1" }));
 assert.match(render("admin-memory-get", { memory: "Текст памяти" }), /Текст памяти/);
 assert.match(render("admin-chats-get", { messages: [{ id: "m", role: "user", text: "Сообщение" }] }), /Сообщение/);
 assert.match(render("admin-artifacts-get", { artifactId: "file-1", filename: "Документ.txt" }), /userId=user-1&amp;artifactId=file-1/);
});
test("invitation provides the exact Telegram command and one-day instructions", () => {
 const file = new URL("../app/admin/invite-command.tsx", import.meta.url);
 const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 const result = { exports: {} as { InviteCommand: ComponentType<{ code: string }> } };
 new Function("require", "module", "exports", compiled)(createRequire(file), result, result.exports);
 const html = renderToStaticMarkup(createElement(result.exports.InviteCommand, { code: "abc_DEF-123" }));
 assert.match(html, /\/start invite_abc_DEF-123/); assert.match(html, /24 часа/);
 assert.match(html, /личном чате с этим ботом/); assert.match(html, /Скопировать команду/);
});
test("archive is a separate read-only target, not a user account", () => {
 const file = new URL("../app/admin/archive-target.tsx", import.meta.url);
 const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 const result = { exports: {} as { ARCHIVE_TARGET: string; ArchiveTarget: ComponentType<{ selected: boolean; onSelect: () => void }> } };
 new Function("require", "module", "exports", compiled)(createRequire(file), result, result.exports);
 assert.equal(result.exports.ARCHIVE_TARGET, "__quarantine__");
 const html = renderToStaticMarkup(createElement(result.exports.ArchiveTarget, { selected: false, onSelect: () => {} }));
 assert.match(html, /Архив до разделения/); assert.match(html, /Неподтверждённые источники доступны только администратору/);
 assert.match(html, /Открыть архив/); assert.doesNotMatch(html, /роль|статус|сесси|приглаш/i);
});

test("memory renders full metadata as text without interpreting markup", () => {
 const html = renderToStaticMarkup(createElement(module.exports.AdminDetail,
  { view:"admin-memory-get", userId:"u", value:{id:"m",memory:"<script>alert(1)</script>",metadata:{source:"<img src=x>"}} }));
 assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
 assert.match(html, /Все сведения и источники/);
 assert.match(html, /&lt;img src=x&gt;/);
 assert.doesNotMatch(html, /<script>|<img /);
});
