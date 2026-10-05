// ABOUTME: Проверяет понятный вывод ответов Codex вместо протокольных тегов и JSON.
// ABOUTME: Обычные сообщения сохраняются; настоящий Item рендерится через React SSR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { desktopMessage } from "../lib/agent/desktop-message.ts";
import { questionReplies } from "../lib/agent/question-reply.ts";
const wrap = (rows: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(rows)}\n</send_user_message_question_reply>`;
const reply = { questionItemId: '["tool","private-id",0]', question: "Как назвать чат?", answer: "По смыслу" };
const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../app/agent/screen.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { Item: (props: { item: { id: string; type: string; text: string }; context: Record<string, never> }) => Parameters<typeof renderToStaticMarkup>[0] } };
const messageSource = readFileSync(new URL("../app/agent/message-text.tsx", import.meta.url), "utf8");
const messageOutput = ts.transpileModule(messageSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const messageModule = { exports: {} as { default: Parameters<typeof createElement>[0] } };
new Function("require", "module", "exports", messageOutput)((name: string) => name === "../../lib/agent/question-reply" ? { questionReplies } : name === "../../lib/agent/desktop-message" ? { desktopMessage } : name === "./markdown" ? { default: ({ text }: { text: string }) => createElement("p", null, text) } : require(name), messageModule, messageModule.exports);
new Function("require", "module", "exports", output + "\nmodule.exports.Item = Item;")((name: string) => name === "./message-text" ? messageModule.exports : ["react", "react/jsx-runtime"].includes(name) ? require(name) : {}, module, module.exports);
const render = (text: string) => renderToStaticMarkup(module.exports.Item({ item: { id: "reply", type: "userMessage", text }, context: {} }));
test("recognized reply shows question and answer without protocol IDs, JSON or tags", () => {
  const html = render(wrap([reply])); assert.match(html, /Как назвать чат\?/); assert.match(html, /Ответ: /); assert.match(html, /По смыслу/); assert.doesNotMatch(html, /private-id|questionItemId|send_user_message_question_reply|&quot;/);
});
test("several answers remain separate; whitespace is accepted and markup stays inert", () => {
  const rows = [reply, { ...reply, question: "Второй вопрос", answer: "<script>alert(1)</script>" }];
  assert.deepEqual(questionReplies(`  ${wrap(rows)}\n`), rows.map(({ question, answer }) => ({ question, answer })));
  const html = render(wrap(rows)); assert.match(html, /Второй вопрос/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
test("ordinary JSON, embedded examples and malformed replies are not rewritten", () => {
  for (const text of [JSON.stringify([reply]), `Пример: ${wrap([reply])}`, wrap([]), wrap({ answer: "yes" }), wrap([{ ...reply, answer: 1 }]), '<send_user_message_question_reply>[broken]</send_user_message_question_reply>', '<send_user_message_question_reply>']) assert.equal(questionReplies(text), null);
});
