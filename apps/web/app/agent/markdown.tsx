// ABOUTME: Отображает ответы агента как ограниченный безопасный Markdown.
// ABOUTME: Разбирает разметку локально и никогда не вставляет сырой HTML в DOM.
import type { ReactNode } from "react";
import "./markdown.css";

type InlinePart = string | ReactNode;

const punctuation = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const listMarker = /^( *)([-+*]|(\d+)[.)])\s+(.*)$/;
const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function safeHref(input: string): string | null {
  const href = input.trim();
  const compact = href.replace(/[\u0000-\u0020\u007f]/g, "");
  if (!href || /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(href) || compact.startsWith("//") || href.includes("\\")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(compact)) return /^(https?:|mailto:)/i.test(compact) ? href : null;
  return href;
}

function closingDelimiter(text: string, delimiter: string, from: number): number {
  let position = from;
  while ((position = text.indexOf(delimiter, position)) !== -1) {
    let slashes = 0;
    for (let i = position - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0 && position > from && text[position - 1] !== " ") return position;
    position += delimiter.length;
  }
  return -1;
}

function linkEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "(") depth++;
    if (text[i] === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function inline(text: string, key = "i"): InlinePart[] {
  const result: InlinePart[] = [];
  let plain = "";
  const flush = () => { if (plain) result.push(plain); plain = ""; };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && i + 1 < text.length && punctuation.test(text[i + 1])) {
      plain += text[i + 1]; i += 2; continue;
    }
    if (text[i] === "`") {
      let count = 1;
      while (text[i + count] === "`") count++;
      const marker = "`".repeat(count), end = text.indexOf(marker, i + count);
      if (end !== -1) {
        flush();
        const code = text.slice(i + count, end).replace(/\n/g, " ").replace(/^ (.*) $/, "$1");
        result.push(<code key={`${key}-${i}`}>{code}</code>);
        i = end + count; continue;
      }
    }
    if (text[i] === "[") {
      const labelEnd = text.indexOf("](", i + 1);
      if (labelEnd !== -1) {
        const end = linkEnd(text, labelEnd + 2);
        if (end !== -1) {
          const rawTarget = text.slice(labelEnd + 2, end).trim().replace(/^<|>$/g, "").replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1").split(/\s+["']/, 1)[0];
          flush();
          const label = inline(text.slice(i + 1, labelEnd), `${key}-${i}`);
          const href = safeHref(rawTarget);
          result.push(href ? <a key={`${key}-${i}`} href={href} rel="noreferrer">{label}</a> : <span key={`${key}-${i}`}>{label}</span>);
          i = end + 1; continue;
        }
      }
    }
    const delimiters = ["**", "__", "~~", "*", "_"];
    const delimiter = delimiters.find(value => text.startsWith(value, i));
    const previous = text[i - 1] ?? "";
    const underscoreInsideWord = (delimiter === "_" || delimiter === "__") && /[\p{L}\p{N}_]/u.test(previous);
    if (delimiter && !underscoreInsideWord && text[i + delimiter.length] && text[i + delimiter.length] !== " ") {
      const end = closingDelimiter(text, delimiter, i + delimiter.length);
      if (end !== -1 && end > i + delimiter.length) {
        flush();
        const child = inline(text.slice(i + delimiter.length, end), `${key}-${i}`);
        const part = delimiter === "~~" ? <del key={`${key}-${i}`}>{child}</del>
          : delimiter.length === 2 ? <strong key={`${key}-${i}`}>{child}</strong>
            : <em key={`${key}-${i}`}>{child}</em>;
        result.push(part); i = end + delimiter.length; continue;
      }
    }
    plain += text[i++];
  }
  flush();
  return result;
}

function splitCells(row: string): string[] {
  const source = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "", ticks = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && source[i + 1] === "|") { cell += "|"; i++; continue; }
    if (source[i] === "`") { ticks = ticks === 0 ? 1 : 0; cell += source[i]; continue; }
    if (source[i] === "|" && ticks === 0) { cells.push(cell.trim()); cell = ""; }
    else cell += source[i];
  }
  cells.push(cell.trim());
  return cells;
}

function parseBlocks(lines: string[], key = "b"): ReactNode[] {
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const codeFence = line.match(fence);
    if (codeFence) {
      const marker = codeFence[1], language = codeFence[2].trim().split(/\s+/, 1)[0];
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const langClass = /^[a-z\d_-]+$/i.test(language) ? `language-${language}` : undefined;
      blocks.push(<pre className="markdown-code-block" key={`${key}-${i}`}><code className={langClass}>{code.join("\n")}</code></pre>);
      continue;
    }
    const title = line.match(heading);
    if (title) {
      const level = title[1].length, children = inline(title[2], `${key}-${i}`);
      const className = "markdown-heading", blockKey = `${key}-${i}`;
      blocks.push(level === 1 ? <h1 className={className} key={blockKey}>{children}</h1> : level === 2 ? <h2 className={className} key={blockKey}>{children}</h2> : level === 3 ? <h3 className={className} key={blockKey}>{children}</h3> : level === 4 ? <h4 className={className} key={blockKey}>{children}</h4> : level === 5 ? <h5 className={className} key={blockKey}>{children}</h5> : <h6 className={className} key={blockKey}>{children}</h6>);
      i++; continue;
    }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      blocks.push(<hr key={`${key}-${i}`} />); i++; continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      blocks.push(<blockquote key={`${key}-${i}`}>{parseBlocks(quote, `${key}-q${i}`)}</blockquote>); continue;
    }
    if (i + 1 < lines.length && line.includes("|") && tableRule.test(lines[i + 1])) {
      const headers = splitCells(line), rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitCells(lines[i++]));
      blocks.push(<div className="markdown-table-wrap" key={`${key}-${i}`}><table><thead><tr>{headers.map((cell, col) => <th key={col}>{inline(cell, `${key}-th${col}`)}</th>)}</tr></thead><tbody>{rows.map((row, ri) => <tr key={ri}>{headers.map((_cell, col) => <td key={col}>{inline(row[col] ?? "", `${key}-td${ri}-${col}`)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const marker = line.match(listMarker);
    if (marker) {
      const baseIndent = marker[1].length, ordered = Boolean(marker[3]), items: { content: string[]; number: number }[] = [];
      while (i < lines.length) {
        const current = lines[i].match(listMarker);
        if (current && current[1].length === baseIndent && Boolean(current[3]) === ordered) {
          items.push({ content: [current[4]], number: Number(current[3] ?? 1) }); i++;
          while (i < lines.length) {
            const next = lines[i], nextMarker = next.match(listMarker);
            if (nextMarker && nextMarker[1].length === baseIndent) break;
            if (!next.trim()) {
              if (i + 1 < lines.length && (lines[i + 1].match(listMarker)?.[1].length ?? -1) >= baseIndent) { items.at(-1)!.content.push(""); i++; continue; }
              break;
            }
            const indentation = next.match(/^ */)![0].length;
            if (indentation <= baseIndent && !nextMarker) break;
            items.at(-1)!.content.push(next.slice(Math.min(indentation, baseIndent + 2))); i++;
          }
          continue;
        }
        break;
      }
      const children = items.map((item, itemIndex) => <li key={`${key}-${i}-${itemIndex}`}>{parseBlocks(item.content, `${key}-li${i}-${itemIndex}`)}</li>);
      blocks.push(ordered ? <ol key={`${key}-${i}`} start={items[0]?.number}>{children}</ol> : <ul key={`${key}-${i}`}>{children}</ul>);
      continue;
    }
    const paragraph = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) && !fence.test(lines[i]) && !/^ {0,3}>/.test(lines[i]) && !listMarker.test(lines[i]) && !/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(lines[i]) && !(i + 1 < lines.length && lines[i].includes("|") && tableRule.test(lines[i + 1]))) paragraph.push(lines[i++].trim());
    blocks.push(<p key={`${key}-${i}`}>{inline(paragraph.join("\n"), `${key}-${i}`)}</p>);
  }
  return blocks;
}

/** Отображает Markdown как React-элементы; сырой HTML остаётся обычным текстом. */
export default function Markdown({ text }: { text: string }) {
  return <div className="agent-markdown">{parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"))}</div>;
}
