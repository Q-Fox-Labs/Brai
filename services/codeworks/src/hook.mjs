#!/usr/bin/env node
// ABOUTME: Останавливает распознанную запись в основную копию и показывает область Codeworks.
// ABOUTME: Не переписывает инструменты, не исполняет shell и не заменяет файловые права sandbox.
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectClient, loadClientConfig} from './client.mjs';
import {readJSON} from './cli.mjs';

function inside(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }

function resolved(value, cwd) {
  const absolute = path.resolve(cwd, value);
  let parent = absolute;
  // AIDEV-NOTE: Проверяем существующего предка, чтобы новые файлы через symlink тоже имели правильный repo.
  while (true) {
    try { return path.join(realpathSync(parent), path.relative(parent, absolute)); }
    catch {
      const next = path.dirname(parent);
      if (next === parent) return absolute;
      parent = next;
    }
  }
}

// Только литеральные слова и простые разделители: это не интерпретатор shell.
function shellTokens(command) {
  const tokens = [];
  let word = '', active = false, dynamic = false, quote;
  const flush = () => {
    if (active) tokens.push({word, dynamic});
    word = ''; active = false; dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = undefined; continue; }
      if (quote === '"' && (c === '$' || c === '`' || c === '\\')) dynamic = true;
      word += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (c === '#' && !active) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (';|&<>\n'.includes(c)) {
      flush();
      const operator = command[i + 1] === c ? c + command[++i] : c;
      tokens.push({operator}); continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if ('$`\\*?(){}'.includes(c)) dynamic = true;
    word += c; active = true;
  }
  if (quote) return [];
  flush();
  return tokens;
}

function shellPaths(command, cwd) {
  const found = [];
  let segment = [];
  const add = token => { if (token && !token.dynamic && token.word && token.word !== '-') found.push(resolved(token.word, cwd)); };
  const flush = () => {
    if (!segment.length) return;
    const words = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i].operator === '>' || segment[i].operator === '>>') { add(segment[++i]); continue; }
      if (!segment[i].operator) words.push(segment[i]);
    }
    segment = [];
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].word)) words.shift();
    if (words[0]?.word === 'rtk' && words[1]?.word === 'proxy') words.splice(0, 2);
    const first = words.shift();
    if (!first || first.dynamic) return;
    const name = path.basename(first.word);
    if (name === 'cd' && words.length === 1 && !words[0].dynamic) { cwd = resolved(words[0].word, cwd); return; }
    const operands = words.filter(token => !token.word.startsWith('-'));
    if (['touch', 'rm', 'rmdir', 'mkdir', 'tee'].includes(name)) operands.forEach(add);
    if (['mv'].includes(name)) operands.forEach(add);
    if (['cp', 'install', 'ln'].includes(name)) {
      const targetFlag = words.findIndex(token => token.word === '-t' || token.word === '--target-directory');
      const targetValue = words.find(token => token.word.startsWith('--target-directory='));
      if (targetFlag !== -1) add(words[targetFlag + 1]);
      else if (targetValue) add({...targetValue, word: targetValue.word.slice('--target-directory='.length)});
      else add(operands.at(-1));
    }
    if (['chmod', 'chown', 'chgrp', 'truncate'].includes(name)) operands.slice(1).forEach(add);
    if (name === 'sed' && words.some(token => /^-i/.test(token.word) || token.word === '--in-place')) operands.slice(1).forEach(add);
  };
  for (const token of shellTokens(command)) {
    if (token.operator && [';', '\n', '&&', '||', '|', '&'].includes(token.operator)) flush();
    else segment.push(token);
  }
  flush();
  return found;
}

/** Извлекает только явные цели поддержанных edits и простых shell writes; неизвестное оставляет инструменту. */
export function writePaths(event) {
  const input = event.tool_input;
  const name = event.tool_name?.split('.').at(-1);
  const cwd = input?.workdir || input?.cwd || event.cwd || process.cwd();
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : input?.command ?? input?.patch;
    return typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(match => resolved(match[1].replace(/\r$/, ''), cwd)) : [];
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const file = input?.file_path ?? input?.path;
    return typeof file === 'string' ? [resolved(file, cwd)] : [];
  }
  if (name === 'Bash' || name === 'exec_command') {
    const command = input?.command ?? input?.cmd;
    return typeof command === 'string' ? shellPaths(command, cwd) : [];
  }
  return [];
}

function denied(context) {
  return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Запись в основную копию требует рабочей области Codeworks.', additionalContext: context}};
}

/** Возвращает официальный PreToolUse DTO; подключается только для распознанной защищённой записи. */
export async function runHook(event, {env = process.env, config, connect = connectClient} = {}) {
  if (event.hook_event_name && event.hook_event_name !== 'PreToolUse') return {};
  const files = writePaths(event);
  if (!files.length) return {};
  if (!config) {
    if (!env.CODEWORKS_HOOK_CONFIG) return {};
    try { config = JSON.parse(await readFile(env.CODEWORKS_HOOK_CONFIG, 'utf8')); }
    catch { return {systemMessage: 'Codeworks hook: публичная конфигурация недоступна; проверьте CODEWORKS_HOOK_CONFIG.'}; }
  }
  const projects = (config.projects ?? []).filter(project => {
    if (typeof project.repo_path !== 'string' || !path.isAbsolute(project.repo_path) || typeof project.id !== 'string') return false;
    const root = resolved(project.repo_path, '/');
    return files.some(file => inside(root, file) && ![...(project.documentation_paths ?? []), ...(project.excluded_paths ?? [])].some(exception => inside(resolved(exception, root), file)));
  });
  if (!projects.length) return {};
  const workspaceKey = env.CODEWORKS_WORKSPACE_KEY || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || event.thread_id || event.session_id;
  if (projects.length !== 1 || !workspaceKey) return denied('Задайте CODEWORKS_WORKSPACE_KEY и выберите один проект. Найдите существующие области через status с project_id. Чтение и диагностика доступны.');
  const project = projects[0];
  const kind = env.CODEWORKS_WORKSPACE_KIND || 'feature';
  const requestKey = 'hook-prepare-' + createHash('sha256').update(JSON.stringify([project.id, workspaceKey, kind])).digest('hex');
  const args = {project_id: project.id, workspace_key: workspaceKey, kind, request_key: requestKey};
  let client;
  try {
    client = await connect(await loadClientConfig(env));
    const result = await client.call('prepare', args);
    return denied(`Область Codeworks: ${JSON.stringify(result)}. Дождитесь ready через status с project_id=${project.id}, workspace_id=${result.workspace_id}, operation_id=${result.operation_id}. Затем повторите исходную запись штатным инструментом по path области, с её рабочим каталогом. Ветка: ${result.branch}. Hook не переносит правки автоматически. workspace_key=${workspaceKey}; request_key=${requestKey}.`);
  } catch (error) {
    if(error?.code==='INVALID_ARGUMENT')return denied('Для новой задачи вызовите prepare с коротким осмысленным workspace_key, например codeworks-auto-cleanup; ID чата не является названием задачи. Для продолжения найдите прежнюю область через status. Затем повторите запись в возвращённом дереве.');
    return denied(`Codeworks недоступен или prepare завершился ошибкой. Исходная запись остановлена; чтение и диагностика доступны. Проверьте status с project_id=${project.id}, workspace_key=${workspaceKey}; повтор prepare использует тот же запрос ${JSON.stringify(args)}. Ошибка ожидания не отменяет операцию.`);
  } finally {
    try { await client?.close(); } catch { /* Не скрываем решение hook при ошибке закрытия соединения. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runHook(await readJSON(process.stdin))) + '\n'); }
  catch { process.stderr.write('Codeworks hook: invalid hook input.\n'); process.exitCode = 1; }
}
