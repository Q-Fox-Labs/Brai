#!/usr/bin/env node
// ABOUTME: Направляет поддержанную запись в подготовленную область Codeworks.
// ABOUTME: Не исполняет shell и не заменяет файловые права sandbox.
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
  let word = '', active = false, dynamic = false, quote, delimiter;
  const heredocs = [];
  let invalid = false;
  const flush = () => {
    if (active) {
      tokens.push({word, dynamic});
      if (delimiter) {
        if (dynamic) invalid = true;
        heredocs.push({word, stripTabs: delimiter.stripTabs});
        delimiter = undefined;
      }
    }
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
    if (c === '<' && command[i + 1] === '<') {
      flush();
      if (delimiter) return [];
      if (command[i + 2] === '<') {
        tokens.push({operator: '<<<'}); i += 2;
      } else {
        delimiter = {stripTabs: command[i + 2] === '-'};
        tokens.push({operator: '<<'}); i += delimiter.stripTabs ? 2 : 1;
      }
      continue;
    }
    if (';|&<>\n'.includes(c)) {
      flush();
      const operator = c !== '\n' && command[i + 1] === c ? c + command[++i] : c;
      tokens.push({operator});
      if (c === '\n') {
        if (delimiter || invalid) return [];
        // AIDEV-NOTE: Тело here-document — данные stdin, а не команды shell.
        // Заголовок и команды после разделителя остаются в проверке записи.
        for (const document of heredocs) {
          let start = i + 1, matched = false;
          while (start <= command.length) {
            const end = command.indexOf('\n', start);
            const line = command.slice(start, end === -1 ? command.length : end);
            if ((document.stripTabs ? line.replace(/^\t+/, '') : line) === document.word) {
              i = end === -1 ? command.length : end;
              matched = true; break;
            }
            if (end === -1) break;
            start = end + 1;
          }
          if (!matched) return [];
        }
        heredocs.length = 0;
      }
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if ('$`\\*?(){}'.includes(c)) dynamic = true;
    word += c; active = true;
  }
  if (quote || delimiter || heredocs.length || invalid) return [];
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

function denied(context, projects) {
  const scope = JSON.stringify(projects.map(({id, repo_path}) => ({id, repo_path})));
  return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Запись в основную копию требует рабочей области Codeworks. Защищённые проекты: ${scope}.`, additionalContext: context}};
}

/** Обрабатывает native write и завершения; не исполняет исходный инструмент. */
export async function runHook(event, {env = process.env, config, connect = connectClient, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 8} = {}) {
  if (!config) {
    if (!env.CODEWORKS_HOOK_CONFIG) return {};
    try { config = JSON.parse(await readFile(env.CODEWORKS_HOOK_CONFIG, 'utf8')); }
    catch { return {systemMessage: 'Codeworks hook: конфигурация недоступна.'}; }
  }
  const projects = config.projects ?? [];
  const eventName = event.hook_event_name ?? 'PreToolUse';
  if (['PostToolUse', 'Stop', 'SubagentStop', 'Interrupt', 'SessionEnd'].includes(eventName)) {
    if (!event.session_id || !event.turn_id || (eventName === 'PostToolUse' && !event.tool_use_id)) return {};
    let client;
    try {
      client = await connect(await loadClientConfig(env));
      for (const project of projects) {
        const args = {project_id: project.id, session_id: event.session_id, turn_id: event.turn_id};
        if (eventName === 'PostToolUse') {
          args.tool_use_id = event.tool_use_id;
          args.outcome = event.tool_response?.isError || event.tool_response?.error ? 'error' : 'success';
        } else args.event = eventName;
        try { await client.call(eventName === 'PostToolUse' ? 'write.finish' : 'write.stop', args); } catch { /* Другому проекту вызов не принадлежит. */ }
      }
    } catch { /* Отсутствие Post оставляет write неопределённым. */ }
    finally { try { await client?.close(); } catch {} }
    return {};
  }
  if (eventName !== 'PreToolUse') return {};
  const files = writePaths(event);
  if (!files.length) return {};
  const matching = projects.filter(project => {
    if (typeof project.repo_path !== 'string' || !path.isAbsolute(project.repo_path) || typeof project.id !== 'string') return false;
    const root = resolved(project.repo_path, '/');
    return files.some(file => inside(root, file) && ![...(project.documentation_paths ?? []), ...(project.excluded_paths ?? [])].some(exception => inside(resolved(exception, root), file)));
  });
  if (!matching.length) return {};
  const deny = message => denied(message, matching);
  const project = matching[0], root = resolved(project.repo_path, '/');
  const excluded = [...(project.documentation_paths ?? []), ...(project.excluded_paths ?? [])].map(p => resolved(p, root));
  if (matching.length !== 1 || files.some(file => !inside(root, file) || excluded.some(p => inside(p, file)))) return deny('Разделите запись по владельцам и исключениям.');
  const name = event.tool_name?.split('.').at(-1);
  // AIDEV-NOTE: Shell может содержать непрозрачный код; он не создаёт область и не переписывается.
  if (!['apply_patch', 'Write', 'Edit'].includes(name)) return deny('Используйте native файловую запись для подготовки области.');
  const key = env.CODEWORKS_WORKSPACE_KEY;
  if (!key || !event.session_id || !event.turn_id || !event.tool_use_id) return deny('Укажите осмысленный CODEWORKS_WORKSPACE_KEY и повторите запись в поддерживаемой сессии.');
  const input = event.tool_input, cwd = input?.workdir || input?.cwd || event.cwd || process.cwd();
  let rewrite;
  if (name === 'apply_patch') {
    const field = typeof input === 'string' ? null : typeof input?.command === 'string' ? 'command' : typeof input?.patch === 'string' ? 'patch' : null;
    const value = field ? input[field] : input;
    if (typeof value !== 'string' || !/^\*\*\* Begin Patch\r?\n/.test(value) || !/\*\*\* End Patch\r?\n?$/.test(value)) return deny('Не удалось однозначно разобрать patch.');
    const headers = [...value.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)];
    if (!headers.length || headers.length !== files.length || /^\*\*\* (?!Begin Patch|End Patch|Add File: |Update File: |Delete File: |Move to: ).+$/m.test(value)) return deny('Не удалось однозначно разобрать patch.');
    rewrite = target => {
      let i = 0;
      const result = value.replace(/^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+?)(\r?)$/gm, (_, prefix, original, cr) => prefix + path.join(target, path.relative(root, files[i++])) + cr);
      return field ? {...input, [field]: result} : result;
    };
  } else {
    const field = typeof input?.file_path === 'string' ? 'file_path' : typeof input?.path === 'string' ? 'path' : null;
    if (!field || files.length !== 1) return deny('Не удалось однозначно разобрать запись.');
    rewrite = target => ({...input, [field]: path.join(target, path.relative(root, files[0]))});
  }
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const kind = env.CODEWORKS_WORKSPACE_KIND || 'feature';
  const payload = hash({tool_name:event.tool_name, tool_input:input, cwd, project_id:project.id, workspace_key:key, kind});
  const args = {project_id:project.id, workspace_key:key, kind, session_id:event.session_id, turn_id:event.turn_id, tool_use_id:event.tool_use_id, tool_name:event.tool_name, payload_sha256:payload, targets:files.map(f=>path.relative(root,f)), request_key:'hook-'+hash([project.id,key,kind]).slice(0,48)};
  let client, result;
  try {
    client = await connect(await loadClientConfig(env));
    result = await client.call('write.begin', args);
    let ready = false;
    for (let i=0; i<polls; i++) {
      const status = await client.call('status', {project_id:project.id, workspace_id:result.workspace_id, operation_id:result.operation_id});
      if (status.workspace?.preparation_state === 'ready') { ready=true; break; }
      if (status.operation?.status === 'failed') break;
      await wait(250);
    }
    if (!ready) {
      await client.call('write.stop', {project_id:project.id,session_id:event.session_id,turn_id:event.turn_id,event:'Stop',write_call_id:result.write_call_id,reason:'prepare_pending'});
      return deny(`PREPARE_PENDING: операция ${result.operation_id}; дождитесь status и повторите запись.`);
    }
    const targetRoot = resolved(result.path, '/');
    if (files.some(file => !inside(targetRoot, resolved(path.join(targetRoot, path.relative(root, file)), '/')))) return deny('Цель записи выходит за пределы рабочей области.');
    const updatedInput = rewrite(targetRoot);
    await client.call('write.admit', {project_id:project.id, write_call_id:result.write_call_id, rewritten_sha256:hash(updatedInput)});
    return {hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'allow', updatedInput}};
  } catch {
    if (client && result?.write_call_id) try { await client.call('write.stop', {project_id:project.id,session_id:event.session_id,turn_id:event.turn_id,event:'Stop',write_call_id:result.write_call_id,reason:'prepare_pending'}); } catch {}
    return deny('PREPARE_PENDING: запись остановлена; проверьте status и повторите её после подготовки.');
  }
  finally { try { await client?.close(); } catch {} }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runHook(await readJSON(process.stdin))) + '\n'); }
  catch { process.stderr.write('Codeworks hook: invalid hook input.\n'); process.exitCode = 1; }
}
