// ABOUTME: Показывает структурированный RichMessage из фактического Telegram receipt.
// ABOUTME: Не разбирает Markdown/HTML и не выполняет кнопки; все строки экранирует React.
import { createElement, Fragment, type ReactNode } from "react";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function plain(value: unknown): string {
  const pending = [value], result: string[] = [];
  while (pending.length) {
    const part = pending.pop();
    if (typeof part === "string") result.push(part);
    else if (Array.isArray(part)) { for (let i = part.length - 1; i >= 0; i--) pending.push(part[i]); }
    else {
      const entry = object(part);
      pending.push(...["text", "blocks", "items", "cells", "summary", "caption", "credit", "alternative_text", "expression", "button"].flatMap(key => entry[key] === undefined ? [] : [entry[key]]).reverse());
    }
  }
  return result.join("");
}
function text(value: unknown, depth = 0): ReactNode {
  if (depth > 48) return plain(value);
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.map((part, i) => <Fragment key={i}>{text(part, depth + 1)}</Fragment>);
  const item = object(value), type = item.type;
  const child = text(item.text, depth + 1);
  const tags: Record<string, string> = { bold: "strong", italic: "em", underline: "u", strikethrough: "s", code: "code", subscript: "sub", superscript: "sup", marked: "mark" };
  if (typeof type === "string" && tags[type]) return createElement(tags[type], null, child);
  if (type === "url" && typeof item.url === "string" && /^https?:\/\//i.test(item.url)) return <a href={item.url} target="_blank" rel="noopener noreferrer">{child}</a>;
  if (type === "custom_emoji") return typeof item.alternative_text === "string" ? item.alternative_text : null;
  if (type === "mathematical_expression") return typeof item.expression === "string" ? <code>{item.expression}</code> : null;
  if (type === "button") return text(object(item.button).text, depth + 1);
  return child;
}
function blocks(value: unknown, depth = 0): ReactNode {
  if (depth > 48) return plain(value);
  return list(value).map((raw, index) => {
    const item = object(raw), type = item.type, child = text(item.text);
    let result: ReactNode;
    if (type === "divider") result = <hr />;
    else if (type === "heading") result = createElement("h" + Math.max(1, Math.min(6, Number(item.size) || 2)), null, child);
    else if (type === "pre") result = <pre>{child}</pre>;
    else if (type === "table") result = <div className="tg-rich-table"><table>{item.caption ? <caption>{text(item.caption)}</caption> : null}<tbody>{list(item.cells).map((row, ri) => <tr key={ri}>{list(row).map((cell, ci) => {
      const entry = object(cell);
      return <td key={ci}>{entry.blocks ? blocks(entry.blocks, depth + 1) : text(entry.text)}</td>;
    })}</tr>)}</tbody></table></div>;
    else if (type === "list") {
      const items = list(item.items), ordered = items.some(value => Number.isInteger(object(value).value));
      result = createElement(ordered ? "ol" : "ul", null, items.map((value, i) => {
        const entry = object(value);
        return <li key={i} value={typeof entry.value === "number" ? entry.value : undefined}>{entry.has_checkbox ? <input type="checkbox" checked={entry.is_checked === true} readOnly /> : null}{blocks(entry.blocks, depth + 1)}</li>;
      }));
    } else if (type === "details") result = <details open={item.is_open === true}><summary>{text(item.summary)}</summary>{blocks(item.blocks, depth + 1)}</details>;
    else if (type === "blockquote" || type === "expandable_blockquote" || type === "pullquote") result = <blockquote>{item.blocks ? blocks(item.blocks, depth + 1) : child}{item.credit ? <cite>{text(item.credit)}</cite> : null}</blockquote>;
    else if (item.blocks) result = <>{blocks(item.blocks, depth + 1)}{text(object(item.caption).text)}</>;
    else if (type === "buttons") result = <p>{list(item.buttons).map((button, i) => <span key={i}>{text(object(button).text)}</span>)}</p>;
    else if (type === "mathematical_expression") result = <pre>{typeof item.expression === "string" ? item.expression : ""}</pre>;
    else result = <p>{child}{text(object(item.caption).text)}</p>;
    return <Fragment key={index}>{result}</Fragment>;
  });
}
/** Отображает сохранённые текстовые блоки Telegram; вложения рендерит отдельный owner-checked компонент. */
export default function TelegramRichMessage({ value, hasAttachments = false }: { value: unknown; hasAttachments?: boolean }) {
  const content = object(value).blocks;
  const mediaOnly = !plain(content) && list(content).some(item => ["photo", "video", "audio", "voice_note", "animation", "document", "collage", "slideshow"].includes(String(object(item).type)));
  return <div className="tg-rich">{blocks(content)}{mediaOnly && !hasAttachments ? <p className="tg-muted">Вложение пока недоступно.</p> : null}</div>;
}
