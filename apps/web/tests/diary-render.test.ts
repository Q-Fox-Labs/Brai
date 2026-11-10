// ABOUTME: Проверяет читаемость записей, исторические даты и безопасный показ расшифровки.
// ABOUTME: Использует синтетические данные; не обращается к API и файлам пользователя.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {test} from "node:test";
import {createElement, type ComponentType, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import type {DiaryEntry} from "../app/diary/types";
const file = new URL("../app/diary/screen.tsx", import.meta.url), require = createRequire(file);
const output = ts.transpileModule(readFileSync(file, "utf8"), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText;
const mod = {exports: {} as {DiaryRecord: ComponentType<{entry: DiaryEntry; userId: string; onRetry?: () => void}>; default: ComponentType<{userId: string; onUnauthorized: () => void}>}};
new Function("require", "module", "exports", output)((name: string) => {
  if (name === "./upload") return {};
  if (name.endsWith(".css")) return {};
  if (name === "../shell/workspace-frame") return {default: ({children, rail}: {children: ReactNode; rail: ReactNode}) => createElement("main", null, rail, children)};
  if (name === "@/components/ui/button") return {Button: (props: object) => createElement("button", props)};
  return require(name);
}, mod, mod.exports);
const base: DiaryEntry = {id: "11111111-1111-4111-8111-111111111111", title: "Первый день", source: "audio", state: "ready", createdAt: "2026-11-08T12:00:00Z", eventDate: "2026-11-01", dateStatus: "identified", dateEvidence: "Первого ноября 2026 года", rawText: "сырой текст", correctedText: "Исправленный текст", audioArtifactId: "22222222-2222-4222-8222-222222222222", errorCode: null, transcription: null, correction: null};
const render = (entry: DiaryEntry) => renderToStaticMarkup(createElement(mod.exports.DiaryRecord, {entry, userId: "owner-a"}));
test("historical event date is distinct from upload date and both transcript versions remain readable", () => {
  const html = render(base);
  assert.match(html, /1 ноября 2026/);
  assert.match(html, /Исправленный текст/);
  assert.match(html, /Исходная расшифровка/);
  assert.match(html, /сырой текст/);
  assert.match(html, /Основание даты/);
  assert.match(html, /account=owner-a/);
});
test("uncertain dates do not inherit the upload day and diary text stays escaped", () => {
  const html = render({...base, eventDate: null, dateStatus: "needs_clarification", correctedText: "<script>bad()</script>", source: "text", audioArtifactId: null});
  assert.match(html, /Дата не определена/);
  assert.match(html, /не удалось однозначно определить дату/);
  assert.match(html, /&lt;script&gt;bad/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<audio"));
});
test("processing and unknown model outcome are shown honestly with preserved raw text", () => {
  const processing = render({...base, state: "transcribing", correctedText: null, rawText: null});
  assert.match(processing, /обработка продолжится|обработку можно дождаться|она продолжится/iu);
  assert.ok(!processing.includes("Исправленный текст"));
  const attention = render({...base, state: "needs_attention", errorCode: "LUNA_OUTCOME_UNKNOWN", correctedText: null});
  assert.match(attention, /автоматического повтора нет/);
  assert.match(attention, /сырой текст/);
});
test("the initial interface starts with audio upload instead of a manual diary form", () => {
  const html = renderToStaticMarkup(createElement(mod.exports.default, {userId: "owner-a", onUnauthorized: () => {}}));
  assert.match(html, /Загрузить аудио/);
  assert.match(html, /type="file"/);
  assert.ok(!html.includes("<textarea"));
  assert.ok(!html.includes('type="date"'));
});

test("a new ASR failure offers explicit retry even after a previous retry", () => {
 let clicks=0;
 for (const transcriptionRetry of [undefined,{key:"33333333-3333-4333-8333-333333333333"}]) {
  const entry={...base,state:"needs_attention" as const,errorCode:"TRANSCRIPTION_FAILED",rawText:null,correctedText:null,transcriptionRetry};
  const html=renderToStaticMarkup(createElement(mod.exports.DiaryRecord,{entry,userId:"owner-a",onRetry:()=>{clicks++;}}));
  assert.match(html,/Повторить расшифровку/);
 }
 assert.equal(clicks,0);
 const html=renderToStaticMarkup(createElement(mod.exports.DiaryRecord,{entry:{...base,state:"transcribing",rawText:null,correctedText:null},userId:"owner-a",onRetry:()=>{clicks++;}}));
 assert.ok(!html.includes("Повторить расшифровку"));
});
