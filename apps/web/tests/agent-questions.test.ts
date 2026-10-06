// ABOUTME: Проверяет переходы карточки Agent и точные ответы без внешних сервисов.
// ABOUTME: Shared UI загружается из исходников, hook runner сохраняет проверку состояния.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingRequest } from "@brai/agent/contracts";

const require = createRequire(import.meta.url), ts = require("typescript") as typeof import("typescript");
const uiCache = new Map<string, Record<string, unknown>>();
function ui(name: string): Record<string, unknown> {
  const path = name.slice("@/components/ui/".length), cached = uiCache.get(path);
  if (cached) return cached;
  const extension = path === "cn" ? "ts" : "tsx", source = readFileSync(new URL(`../components/ui/${path}.${extension}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  uiCache.set(path, module.exports);
  new Function("require", "module", "exports", output)((dependency: string) => dependency.startsWith("@/components/ui/") ? ui(dependency) : require(dependency), module, module.exports);
  uiCache.set(path, module.exports);
  return module.exports;
}
const source = readFileSync(new URL("../app/agent/questions.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
type KeyEvent = { key: string; shiftKey: boolean; repeat: boolean; preventDefault: () => void; nativeEvent: { isComposing?: boolean; keyCode?: number } };
type TestProps = { [key: string]: unknown; children?: ReactNode; onClick?: () => void; onSubmit?: (event: { preventDefault: () => void }) => void; onChange?: (event: { target: { value: string } }) => void; onKeyDown?: (event: KeyEvent) => void };
type Node = ReactElement<TestProps>;
const question = (id: string, extra = {}) => ({ id, header: "Скрытый заголовок", question: `Вопрос ${id}?`, options: [{ label: "Первый (Recommended)", description: "Описание первого" }, { label: "Второй", description: "Описание второго" }], ...extra });
const request = (questions = [question("a"), question("b", { isOther: true })]): PendingRequest => ({ requestId: "number:42", kind: "question", method: "item/tool/requestUserInput", turnId: "turn", answered: false, params: { questions } });

function fixture(value = request(), send: (answer: unknown) => Promise<boolean> = async () => true) {
  const state: unknown[] = []; let cursor = 0, disabled = false;
  const hooks = {
    useState: <T>(initial: T) => { const slot = cursor++; if (!(slot in state)) state[slot] = initial; return [state[slot] as T, (next: T | ((previous: T) => T)) => { state[slot] = typeof next === "function" ? (next as (previous: T) => T)(state[slot] as T) : next; }]; },
    useRef: <T>(initial: T) => { const slot = cursor++; return state[slot] ??= { current: initial }; },
    useId: () => `question-${cursor++}`, useEffect: () => {},
  };
  const module = { exports: {} as { default: (props: { request: PendingRequest; disabled: boolean; send: typeof send }) => Node } };
  new Function("require", "module", "exports", compiled)((name: string) => name === "react" ? hooks : name.startsWith("@/components/ui/") ? ui(name) : require(name), module, module.exports);
  const render = () => { cursor = 0; return module.exports.default({ request: value, disabled, send }); };
  const nodes = (node: ReactNode): Node[] => {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!isValidElement<TestProps>(node)) return [];
    const wrappers = [uiCache.get("button")?.Button, uiCache.get("input")?.Input, uiCache.get("textarea")?.Textarea, uiCache.get("card")?.Card];
    if (node.type === uiCache.get("card")?.Card) return nodes(node.props.children);
    if (wrappers.includes(node.type)) {
      if (typeof node.type === "function") return nodes((node.type as (props: TestProps) => ReactNode)(node.props));
      const render = (node.type as unknown as { render?: (props: TestProps, ref: null) => ReactNode }).render;
      if (render) return nodes(render(node.props, null));
    }
    return [node, ...nodes(node.props.children)];
  };
  const find = (predicate: (node: Node) => boolean) => { const found = nodes(render()).find(predicate); assert.ok(found); return found; };
  const option = (index: number) => find(node => node.props["data-question-option"] === index);
  const button = (label: string) => find(node => node.type === "button" && node.props["aria-label"] === label);
  const skip = () => find(node => Object.hasOwn(node.props, "data-question-skip")).props.onClick!();
  const input = () => find(node => node.type === "input" || node.type === "textarea");
  const change = (text: string) => input().props.onChange!({ target: { value: text } });
  const submit = () => find(node => node.type === "form").props.onSubmit!({ preventDefault() {} });
  const html = () => renderToStaticMarkup(render());
  return { render, html, find, option, button, skip, input, change, submit, disable: (next: boolean) => { disabled = next; } };
}

test("one visible question shows numbered options and a badge without choosing the initial highlight", () => {
  let calls = 0;
  const f = fixture(request(), async () => { calls++; return true; });
  assert.match(f.html(), /Вопрос a\?/); assert.doesNotMatch(f.html(), /Вопрос b\?|Скрытый заголовок|<select|<datalist/);
  assert.match(f.html(), /Рекомендуемый/); assert.match(f.html(), /Описание первого/); assert.doesNotMatch(f.html(), /\(Recommended\)/);
  assert.equal(f.option(0).props["aria-pressed"], false); assert.equal(calls, 0);
});

test("navigation, collapse and drafts retain exact answers; last decision sends once", async () => {
  const calls: unknown[] = [];
  const f = fixture(request(), async answer => { calls.push(answer); return true; });
  f.option(0).props.onClick!(); f.change("Мой ответ"); f.button("Свернуть вопросы").props.onClick!();
  f.find(node => node.props.className === "agent-question-reopen").props.onClick!();
  assert.equal(f.input().props.value, "Мой ответ"); f.button("Предыдущий вопрос").props.onClick!();
  assert.equal(f.option(0).props["aria-pressed"], true); f.button("Следующий вопрос").props.onClick!();
  const staleSubmit = f.find(node => node.type === "form").props.onSubmit;
  f.submit(); staleSubmit!({ preventDefault() {} }); await Promise.resolve();
  assert.deepEqual(calls, [{ answers: { a: { answers: ["Первый (Recommended)"] }, b: { answers: ["Мой ответ"] } } }]);
});

test("last skip visits an undecided earlier question instead of silently skipping it", async () => {
  const calls: unknown[] = [];
  const f = fixture(request(), async answer => { calls.push(answer); return true; });
  f.button("Следующий вопрос").props.onClick!(); f.skip();
  assert.match(f.html(), /Вопрос a\?/); assert.equal(calls.length, 0);
  f.skip(); f.skip(); await Promise.resolve();
  assert.deepEqual(calls, [{ answers: { a: { answers: [] }, b: { answers: [] } } }]);
});

test("confirmed refusal retains answers; disabled, locked and answered requests cannot send", async () => {
  const calls: unknown[] = [];
  const f = fixture(request([question("a", { isOther: true })]), async answer => { calls.push(answer); return calls.length !== 1; });
  f.change("Ответ"); f.submit(); await Promise.resolve(); assert.equal(f.input().props.value, "Ответ");
  f.disable(true); f.submit(); assert.equal(calls.length, 1);
  f.disable(false); f.submit(); await Promise.resolve(); f.submit(); assert.equal(calls.length, 2);
  const answered = fixture({ ...request(), answered: true }, async () => { throw new Error("cannot send"); });
  answered.option(0).props.onClick!(); answered.skip();
});

test("own answers honor isOther, secrets, whitespace, IME and deliberate Enter", async () => {
  assert.doesNotMatch(fixture(request([question("a")])).html(), /textarea|type="password"/);
  const calls: unknown[] = [];
  const f = fixture(request([question("secret", { options: null, isSecret: true })]), async answer => { calls.push(answer); return true; });
  assert.equal(f.input().props.type, "password"); assert.equal(f.input().props.autoComplete, "off");
  f.change("   "); f.submit(); assert.equal(calls.length, 0); f.change("private-answer");
  const key = (extra: Partial<KeyEvent>) => f.input().props.onKeyDown!({ key: "Enter", shiftKey: false, repeat: false, preventDefault() {}, nativeEvent: { isComposing: false }, ...extra });
  key({ repeat: true }); key({ shiftKey: true }); key({ nativeEvent: { isComposing: true } }); key({ nativeEvent: { keyCode: 229 } });
  assert.equal(calls.length, 0); key({}); await Promise.resolve();
  assert.deepEqual(calls, [{ answers: { secret: { answers: ["private-answer"] } } }]);
});

test("partial async reply from another client retains the remaining question and draft", () => {
  const value = request(); value.method = "agentMessage/questions";
  const f = fixture(value);
  f.button("Следующий вопрос").props.onClick!(); f.change("Мой черновик");
  value.params.questions = value.params.questions.slice(1);
  assert.match(f.html(), /Вопрос b\?/);
  assert.equal(f.input().props.value, "Мой черновик");
  assert.match(f.html(), /1 из 1/);
});
