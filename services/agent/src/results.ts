// ABOUTME: Привязывает завершённые Markdown результаты к устойчивому scope artifacts.
// ABOUTME: Не читает локальные файлы и добавляет owner metadata только в авторизованный RPC.
import { posix } from 'node:path';
import { performance } from 'node:perf_hooks';
import { subjects } from '../../artifacts/contracts/index.mjs';
import type { Artifact, ArtifactOutputBinding } from '../../artifacts/contracts/index.mjs';
import type { Command, DisplayItem, Result } from '../contracts/index.mjs';
import { bytes, limits } from '../contracts/index.mjs';
import type { ArtifactsConfig, ArtifactsPort } from './attachments.js';
import type { CodexPort } from './codex.js';
type Target = { artifactId: string; target: string; filename: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escaped = (source: string, index: number) => { let count = 0; while (index > 0 && source[--index] === '\\') count++; return count % 2 === 1; };

/** Извлекает inline file/image links только из точного root/UUID/filename, вне кода. */
export function resultTargets(source: string, root: string): Target[] {
  // AIDEV-NOTE: Маска сохраняет позиции; literal/escaped/code ссылки не создают публикацию.
  const masked = source.split('');
  let offset = 0, fence: { marker: string; length: number } | undefined;
  for (const line of source.split(/(?<=\n)/)) {
    // AIDEV-NOTE: Quote/list containers не превращают fenced code в обычные ссылки.
    let body = line, previous;
    do { previous = body; body = body.replace(/^ {0,3}>[ \t]?|^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]+/, ''); } while (body !== previous);
    const marker = body.replace(/\r?\n$/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const inCode = Boolean(fence) || Boolean(marker) || /^(?: {4}|\t)/.test(body);
    if (fence) { if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined; }
    else if (marker) fence = { marker: marker[1][0], length: marker[1].length };
    if (inCode) masked.fill(' ', offset, offset + line.length);
    offset += line.length;
  }
  let prose = masked.join('');
  for (const match of prose.matchAll(/<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi)) masked.fill(' ', match.index, match.index + match[0].length);
  prose = masked.join('');
  for (let i = 0; i < prose.length; i++) if (prose[i] === '`' && !escaped(prose, i)) {
    let end = i + 1; while (prose[end] === '`') end++;
    const run = prose.slice(i, end); let close = prose.indexOf(run, end);
    while (close >= 0 && (prose[close - 1] === '`' || prose[close + run.length] === '`')) close = prose.indexOf(run, close + run.length);
    if (close >= 0) { masked.fill(' ', i, close + run.length); i = close + run.length - 1; }
    else i = end - 1;
  }
  prose = masked.join('');
  const found: Target[] = [], seen = new Set<string>(), prefix = root + '/';
  for (let i = 0; i < prose.length; i++) {
    if (prose[i] !== '[' || escaped(prose, i) || prose[i - 1] === '!' && escaped(prose, i - 1)) continue;
    let end = i + 1, depth = 1;
    for (; end < prose.length && depth; end++) if (!escaped(prose, end)) { if (prose[end] === '[') depth++; else if (prose[end] === ']') depth--; }
    if (depth || prose[end] !== '(') continue;
    let cursor = end + 1; while (/\s/.test(prose[cursor] ?? '') && cursor < prose.length) cursor++;
    let target: string;
    if (prose[cursor] === '<') {
      const close = prose.indexOf('>', cursor + 1); if (close < 0) continue;
      target = prose.slice(cursor + 1, close); cursor = close + 1;
    } else {
      const start = cursor; let parentheses = 0;
      while (cursor < prose.length) {
        const char = prose[cursor];
        if (/\s/.test(char) || char === ')' && !parentheses) break;
        if (char === '(') parentheses++; else if (char === ')') parentheses--;
        cursor++;
      }
      target = prose.slice(start, cursor);
    }
    const tail = prose.slice(cursor).match(/^(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/);
    if (!tail) continue;
    i = cursor + tail[0].length - 1;
    if (!target.startsWith(prefix) || /[\\\x00-\x1f\x7f<>?#]/.test(target)) continue;
    const parts = target.slice(prefix.length).split('/');
    if (parts.length !== 2 || !uuid.test(parts[0]) || !parts[1] || ['.', '..'].includes(parts[1]) || /%[0-9a-f]{2}/i.test(parts[1])) continue;
    const artifactId = parts[0].toLowerCase();
    if (seen.has(artifactId)) continue;
    seen.add(artifactId); found.push({ artifactId, target, filename: parts[1] });
  }
  return found;
}

/** Native completion/recovery использует trusted owner; shared проекция хранит только число. */
export function createResults(codex: CodexPort, config: ArtifactsConfig | undefined, ownerId: string | undefined, port?: ArtifactsPort) {
  const root = config?.resultRoot;
  if (root !== undefined && (typeof root !== 'string' || !root.startsWith('/') || root.endsWith('/') || posix.normalize(root) !== root || /[\\\x00-\x1f\x7f<>?#]/.test(root) || typeof ownerId !== 'string' || !ownerId || Array.from(ownerId).length > 128 || /\s/.test(ownerId))) throw new Error('INVALID_AGENT_CONFIG');
  const enabled = Boolean(root && ownerId), budget = config?.timeoutMs ?? 10000;
  const candidates = new Map<string, Target[]>();
  let candidateBytes = 0;
  const key = (r: Command, itemId: string) => JSON.stringify([r.projectId, r.threadId, itemId]);
  const count = (item: any) => root && item.type === 'agentMessage' && typeof item.text === 'string' ? resultTargets(item.text, root).length : 0;
  function remember(r: Command, entry: any) {
    const targets = root && entry.item.type === 'agentMessage' && typeof entry.item.text === 'string' ? resultTargets(entry.item.text, root) : [];
    if (targets.length) {
      const id = key(r, entry.item.id), previous = candidates.get(id);
      if (previous) { candidateBytes -= bytes(previous); candidates.delete(id); }
      const size = bytes(targets);
      if (size <= limits.state) { candidates.set(id, targets); candidateBytes += size; }
      while (candidates.size > 128 || candidateBytes > limits.state) {
        const oldest = candidates.keys().next().value!;
        candidateBytes -= bytes(candidates.get(oldest)); candidates.delete(oldest);
      }
    }
    return targets;
  }
  function remaining(deadline: number, generation: string) {
    if (generation !== codex.status().generation) throw Object.assign(new Error('STALE_GENERATION'), { code: 'STALE_GENERATION', outcome: 'query' });
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw new Error('TIMEOUT');
    return left;
  }
  async function query(subject: string, value: unknown, deadline: number, generation: string) {
    if (!port) throw new Error('UPSTREAM_UNAVAILABLE');
    const result = await port!.request(subject, value, { timeoutMs: remaining(deadline, generation) });
    remaining(deadline, generation);
    return result;
  }
  const scope = (r: Command) => ({ ownerId: ownerId!, projectId: r.projectId!, threadId: r.threadId! });
  const matches = (binding: ArtifactOutputBinding, r: Command, item: { id: string; turnId: string }) => binding.ownerId === ownerId && binding.projectId === r.projectId && binding.threadId === r.threadId && binding.itemId === item.id && binding.turnId === item.turnId;
  /** Не привязывает started/streaming item; existing binding переживает удаление файла. */
  async function recoverItems(r: Command, entries: any[], deadline = performance.now() + budget, generation = codex.status().generation) {
    if (!enabled) return true;
    const completed = entries.filter(entry => entry.item.type === 'agentMessage' && entry.completedAtMs != null);
    if (!completed.length) return true;
    trackItems(r, completed);
    try {
      const bindings: ArtifactOutputBinding[] = (await query(subjects.outputList, { ...scope(r), itemIds: completed.map(entry => entry.item.id) }, deadline, generation)).bindings;
      for (const entry of completed) {
        if (bindings.some(binding => matches(binding, r, { id: entry.item.id, turnId: entry.turnId }))) continue;
        const targets = candidates.get(key(r, entry.item.id)); if (!targets?.length) continue;
        const artifactIds: string[] = [];
        for (const target of targets) {
          let artifact: Artifact;
          try { artifact = await query(subjects.get, { artifactId: target.artifactId }, deadline, generation); }
          catch (error: any) { if (error.code === 'NOT_FOUND') continue; throw error; }
          if (artifact.ownerId === ownerId && artifact.artifactId.toLowerCase() === target.artifactId && artifact.status === 'ready' && artifact.filename === target.filename) artifactIds.push(target.artifactId);
        }
        if (artifactIds.length) await query(subjects.outputBind, { ...scope(r), turnId: entry.turnId, itemId: entry.item.id, artifactIds }, deadline, generation);
      }
      return true;
    } catch { return false; /* Recovery повторяется по native истории; incoming ledger не меняется. */ }
  }
  /** Запоминает только ссылки завершённого полного native текста до display truncation. */
  function trackItems(r: Command, entries: any[]) {
    if (!enabled) return;
    for (const entry of entries) if (entry.item.type === 'agentMessage' && entry.completedAtMs != null && typeof entry.item.text === 'string') remember(r, entry);
  }
  /** Descriptors принадлежат только trusted owner RPC и повторяются на каждой текстовой странице. */
  async function decorate(r: Command, items: DisplayItem[]): Promise<DisplayItem[]> {
    const copy = structuredClone(items);
    if (!enabled || r.ownerId !== ownerId) return copy;
    const messages = copy.filter(item => item.type === 'agentMessage'); if (!messages.length) return copy;
    const generation = codex.status().generation, deadline = performance.now() + budget;
    let unavailable = false;
    try {
      if (!await recoverItems(r, messages.filter(item => candidates.has(key(r, item.id))).map(item => ({ item: { id: item.id, type: item.type }, turnId: item.turnId, completedAtMs: 0 })), deadline, generation)) throw new Error('UPSTREAM_UNAVAILABLE');
      const bindings: ArtifactOutputBinding[] = (await query(subjects.outputList, { ...scope(r), itemIds: messages.map(item => item.id) }, deadline, generation)).bindings;
      for (const item of messages) {
        const binding = bindings.find(binding => matches(binding, r, item));
        if (!binding) { if (item.resultCount) item.resultsState = 'unavailable'; continue; }
        item.results = []; item.resultsState = 'ready'; item.resultCount = binding.artifactIds.length;
        for (const artifactId of binding.artifactIds) {
          const target = candidates.get(key(r, item.id))?.find(target => target.artifactId === artifactId);
          const result: Result = { artifactId, target: target?.target ?? '', filename: target?.filename ?? '', mimeType: '', sizeBytes: 0, state: 'unavailable' };
          if (!unavailable) try {
            const artifact: Artifact = await query(subjects.get, { artifactId }, deadline, generation);
            if (artifact.ownerId !== ownerId || artifact.artifactId.toLowerCase() !== artifactId) throw new Error('INVALID_ARGUMENT');
            result.filename = artifact.filename; result.target = target?.target ?? `${root}/${artifactId}/${artifact.filename}`;
            result.mimeType = artifact.mimeType; result.sizeBytes = artifact.sizeBytes ?? 0;
            result.state = ['deleted', 'deleting'].includes(artifact.status) ? 'deleted' : artifact.status === 'ready' ? 'ready' : 'unavailable';
            if (result.state === 'ready') {
              const url = `/api/agent/results/${artifactId}?` + new URLSearchParams({ projectId: r.projectId!, threadId: r.threadId!, turnId: item.turnId, itemId: item.id, expectedUserId: ownerId! });
              result.previewUrl = url; result.downloadUrl = url + '&download=1';
            }
          } catch { unavailable = true; }
          if (result.state === 'unavailable') item.resultsState = 'unavailable';
          item.results.push(result);
          // AIDEV-NOTE: Metadata не обрезает текст и не превращает превышение кадра в потерю descriptors.
          if (bytes(copy) > limits.state - 2048) throw Object.assign(new Error('CAPACITY_EXHAUSTED'), { code: 'CAPACITY_EXHAUSTED', outcome: 'query' });
        }
      }
    } catch (error: any) {
      if (error.code === 'CAPACITY_EXHAUSTED') throw error;
      for (const item of messages) if (item.resultCount) item.resultsState = 'unavailable';
    }
    if (generation !== codex.status().generation) throw Object.assign(new Error('STALE_GENERATION'), { code: 'STALE_GENERATION', outcome: 'query' });
    return copy;
  }
  return { count, recoverItems, trackItems, decorate };
}
