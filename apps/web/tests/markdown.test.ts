// ABOUTME: Проверяет безопасный вывод основных конструкций Markdown в HTML.
// ABOUTME: Рендерит настоящий TSX через React SSR и не проверяет исходный текст regexp-ами.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../app/agent/markdown.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const module = { exports: {} as { default: (props: { text: string }) => unknown } };
new Function("require", "module", "exports", output)((name: string) => name === "./markdown.css" ? {} : require(name), module, module.exports);
const Markdown = module.exports.default;
const render = (text: string) => renderToStaticMarkup(Markdown({ text }) as Parameters<typeof renderToStaticMarkup>[0]);

test("renders Russian paragraphs, inline formatting, links, escaped punctuation and code", () => {
  const html = render("Обычный русский текст\nна нескольких строках. **Жирный** текст, *курсив*, ~~зачёркнутый~~ и `main`.\n\nСсылка [Новый интерфейс уже доступен](https://the.brai.one/agent), скобки [путь](/path_(name)).\nЭкранировано: \\*звёздочки\\*, \\`backtick\\`, \\[квадратные скобки\\]. word_with_under.");
  assert.match(html, /Обычный русский текст\nна нескольких строках\./);
  assert.match(html, /<strong>Жирный<\/strong> текст/);
  assert.match(html, /<em>курсив<\/em>/);
  assert.match(html, /<del>зачёркнутый<\/del>/);
  assert.match(html, /<code>main<\/code>/);
  assert.match(html, /href="https:\/\/the\.brai\.one\/agent"[^>]*>Новый интерфейс уже доступен/);
  assert.match(html, /href="\/path_\(name\)"/);
  assert.match(html, /\*звёздочки\*, `backtick`, \[квадратные скобки\]/);
  assert.match(html, /word_with_under/);
  assert.doesNotMatch(html, /<em>with<\/em>/);
});

test("renders fenced code with language as text and keeps markup inert", () => {
  const html = render("```typescript\nconst main = `<script>alert(1)</script>`;\n```\n\n<script>alert('html')</script>");
  assert.match(html, /<pre class="markdown-code-block"><code class="language-typescript">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&#x27;html&#x27;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("renders nested lists, headings, quotes, GFM tables and horizontal rules", () => {
  const html = render("## Заголовок\n\n1. Первый\n2. Второй\n   - Вложенный\n   - Ещё один\n\n> Цитата\n> продолжение\n\n| Имя | Значение |\n| --- | :---: |\n| Brai | `main` |\n\n---");
  assert.match(html, /<h2 class="markdown-heading">Заголовок<\/h2>/);
  assert.match(html, /<ol start="1">/);
  assert.match(html, /<ul><li><p>Вложенный/);
  assert.match(html, /<blockquote><p>Цитата\nпродолжение<\/p><\/blockquote>/);
  assert.match(html, /<table><thead>/);
  assert.match(html, /<th>Имя<\/th>/);
  assert.match(html, /<td><code>main<\/code><\/td>/);
  assert.match(html, /<hr\/>/);
});

test("rejects executable, entity-obfuscated, whitespace-obfuscated and network-path URLs", () => {
  const html = render("[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](java script:alert(1)) [d](data:text/html,x) [e](vbscript:msgbox(1)) [f](java&#x73;cript:alert(1)) [g](//evil.example/x)");
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /<span>a<\/span>/);
  assert.match(html, /<span>b<\/span>/);
  assert.match(html, /<span>f<\/span>/);
});
