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
    catch (error) {
      if (!['ENOENT','ENOTDIR'].includes(error?.code)) throw error;
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

// Допускаем только один простой вызов с явно безопасными аргументами.
function readOnlyShell(command) {
  if (typeof command !== 'string') return false;
  const tokens = shellTokens(command);
  if (!tokens.length || tokens.some(t => t.operator || t.dynamic)) return false;
  const words = tokens.map(t=>t.word);
  if (words[0] === 'rtk' && words[1] === 'proxy') words.splice(0,2);
  if (words[0] === 'git') return words[1] === 'status' && words.slice(2).every(w=>['--short','-s','--porcelain','--porcelain=v1','--branch','-b','--untracked-files=no'].includes(w));
  if (words[0] === 'cat') return words.length > 1 && words.slice(1).every(w=>w !== '-' && !w.startsWith('-'));
  if (words[0] === 'rg') return words.length > 1 && words.slice(1).every(w=>!w.startsWith('-') || ['-n','-i','-l','--files','--hidden','--no-heading'].includes(w));
  return false;
}

// Разрешаем только обычные Git argv; shell операторы и нестандартные опции исключены.
function synchronousGit(command) {
  if (typeof command !== 'string') return false;
  const tokens=shellTokens(command);
  if (!tokens.length || tokens.some(t=>t.operator || t.dynamic)) return false;
  const words=tokens.map(t=>t.word);
  if (words[0]==='rtk' && words[1]==='proxy') words.splice(0,2);
  if (words.shift()!=='git') return false;
  const action=words.shift();
  if (action==='add') return words.length>0 && words.every(w=>!w.startsWith('-') || ['-A','--all','-u','--update','--'].includes(w));
  if (action==='push') return words.length>0 && words.every(w=>!w.startsWith('-') || ['-u','--set-upstream','--'].includes(w));
  if (action==='commit') {
    let message=false;
    for (let i=0;i<words.length;i++) {
      const w=words[i];
      if (w==='-m' || w==='--message') { if (++i>=words.length) return false; message=true; continue; }
      if (w.startsWith('--message=')) {message=true; continue;}
      if (!['-a','--all','--amend','--no-edit'].includes(w)) return false;
    }
    return message || words.includes('--no-edit');
  }
  return false;
}
// Обрабатываем только проверяемые foreground argv; произвольные скрипты и фоновые операции остаются неизвестными.
function foregroundCommand(command) {
  if (typeof command !== 'string') return false;
  const tokens=shellTokens(command);
  if (!tokens.length || tokens.some(t=>t.dynamic)) return false;
  let segment=[];
  const allowed = () => {
    if (!segment.length) return false;
    const words=segment.map(t=>t.word);
    const literal=words.map(w=>"'"+w.replaceAll("'", "'\\''")+"'").join(' ');
    if (readOnlyShell(literal) || synchronousGit(literal)) return true;
    if (words[0]==='head' || words[0]==='tail') return words.slice(1).every(w=>!w.startsWith('-') || /^-(?:n)?[0-9]+$/.test(w) || w==='-n');
    if (words[0]==='sed') return words[1]==='-n' && /^\d+(?:,\d+)?p$/.test(words[2]??'') && words.slice(3).every(w=>!w.startsWith('-'));
    if (words[0]!=='node') return false;
    if (words[1]==='--test') return words.slice(2).every(w=>!w.startsWith('-') || /^--test-(?:reporter|name-pattern|concurrency)=.+$/.test(w));
    if (!/^(?:\.\/)?services\/codeworks\/components\/cli\.mjs$/.test(words[1]??'') || !['build','check','package','run','plan','validate'].includes(words[2])) return false;
    return words.slice(3).every(w=>!w.startsWith('-') || ['--base','--root','--no-deps'].includes(w));
  };
  for (let i=0; i<tokens.length; i++) {
    const token=tokens[i];
    if (!token.operator) {segment.push(token);continue;}
    if (['>','>>'].includes(token.operator)) {
      // AIDEV-NOTE: Только literal redirect и stderr-to-stdout; отдельный & не является завершённым foreground вызовом.
      const fd=['1','2'].includes(segment.at(-1)?.word) ? segment.pop().word : null;
      const next=tokens[++i];
      if (next?.operator==='&') {
        const target=tokens[++i];
        if (token.operator!=='>' || fd!=='2' || target?.operator || target?.word!=='1') return false;
      } else if (!next || next.operator || next.dynamic || !next.word) return false;
      continue;
    }
    if (!['&&',';','|','\n'].includes(token.operator) || !allowed()) return false;
    segment=[];
  }
  return allowed();
}
function completedShell(event) {
  const name=event.tool_name?.split('.').at(-1), input=event.tool_input, response=event.tool_response;
  if (input?.run_in_background || input?.background || input?.async) return false;
  if (response && typeof response==='object') return !response.session_id && !response.sessionId && !['running','pending'].includes(response.status) && (name==='Bash' || Number.isInteger(response.exit_code));
  if (typeof response!=='string' || /(?:session[_ ]id|process running|still running)/i.test(response)) return false;
  // AIDEV-NOTE: Native Bash PostToolUse подтверждает ответ инструмента; его stdout не является exit code.
  return name==='Bash' || /^Process exited with code\s*:?\s*\d+\s*$/im.test(response.split(/\nOutput:\s*\n/)[0]);
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
export function writePaths(event, resolveTarget = resolved) {
  const input = event.tool_input;
  const name = event.tool_name?.split('.').at(-1);
  const cwd = input?.workdir || input?.cwd || event.cwd || process.cwd();
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : input?.command ?? input?.patch;
    return typeof patch === 'string' ? [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(match => resolveTarget(match[1].replace(/\r$/, ''), cwd)) : [];
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const file = input?.file_path ?? input?.path;
    return typeof file === 'string' ? [resolveTarget(file, cwd)] : [];
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

const safeHookCodes=new Set(['FORBIDDEN','CONFLICT','WRITE_CALL_MISMATCH','CLEANUP_ALREADY_STARTED','INVALID_ARGUMENT','INTERNAL','NOT_FOUND','WORKSPACE_WRITE_REQUIRED','WRITER_OUTCOME_UNKNOWN','PREPARE_PENDING','BUSY']);
function hookFailure(error) {
  const code=safeHookCodes.has(error?.code) ? error.code : 'BACKEND_UNAVAILABLE';
  return `${code}: запись остановлена; проверьте состояние Codeworks.`;
}

/** Обрабатывает native write и завершения; не исполняет исходный инструмент. */
export async function runHook(event, options = {}) {
  try { return await runHookInner(event, options); }
  catch { return denied('Невозможно безопасно определить цель записи; проверьте доступ к пути.', []); }
}
async function runHookInner(event, {env = process.env, config, connect = connectClient, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), polls = 8, resolveTarget = resolved} = {}) {
  if (!config) {
    if (!env.CODEWORKS_HOOK_CONFIG) return {};
    try { config = JSON.parse(await readFile(env.CODEWORKS_HOOK_CONFIG, 'utf8')); }
    catch { return {systemMessage: 'Codeworks hook: конфигурация недоступна.'}; }
  }
  const projects = config.projects ?? [];
  const eventName = event.hook_event_name ?? 'PreToolUse';
  if (['PostToolUse', 'Stop', 'SubagentStop', 'Interrupt', 'SessionEnd'].includes(eventName)) {
    if (!event.session_id || !event.turn_id || (eventName === 'PostToolUse' && !event.tool_use_id)) return {};
    const shellPost = eventName === 'PostToolUse' && ['Bash','exec_command','write_stdin'].includes(event.tool_name?.split('.').at(-1));
    const finished = shellPost && completedShell(event);
    // AIDEV-NOTE: Только распознанный завершённый foreground вызов снимает учёт; произвольный shell может оставить потомков.
    if (shellPost && (!foregroundCommand(event.tool_input?.command ?? event.tool_input?.cmd) || !finished)) return {};
    let client;
    try {
      client = await connect(await loadClientConfig(env));
      for (const project of projects) {
        const args = {project_id: project.id, session_id: event.session_id, turn_id: event.turn_id};
        if (eventName === 'PostToolUse') {
          args.tool_use_id = event.tool_use_id;
          args.outcome = event.tool_response?.isError || event.tool_response?.error || (Number.isInteger(event.tool_response?.exit_code) && event.tool_response.exit_code !== 0) ? 'error' : 'success';
        } else args.event = eventName;
        try { await client.call(eventName === 'PostToolUse' ? 'write.finish' : 'write.stop', args); } catch { /* Другому проекту вызов не принадлежит. */ }
      }
    } catch { /* Отсутствие Post оставляет write неопределённым. */ }
    finally { try { await client?.close(); } catch {} }
    return {};
  }
  if (eventName !== 'PreToolUse') return {};
  const files = writePaths(event, resolveTarget);
  const input = event.tool_input, cwd = input?.workdir || input?.cwd || event.cwd || process.cwd();
  const name = event.tool_name?.split('.').at(-1);
  const shell = ['Bash','exec_command'].includes(name);
  const candidates = [...files, ...(shell ? [resolved(cwd, '/')] : [])];
  const areas = new Map();
  for (const project of projects) {
    if (!path.isAbsolute(project.workspace_root ?? '')) continue;
    const base = resolved(project.workspace_root, '/');
    for (const file of candidates) {
      if (!inside(base,file) || file === base) continue;
      const id = path.relative(base,file).split(path.sep)[0];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
      areas.set(project.id+':'+id,{project,id,root:path.join(base,id)});
    }
  }
  if (areas.size > 1) return denied('Разделите запись между рабочими областями.',[...areas.values()].map(a=>a.project));
  if (areas.size === 1 && shell && readOnlyShell(input?.command ?? input?.cmd)) return {};
  if (areas.size === 1) return existingWrite(event,[...areas.values()][0],{env,connect,files,shell,cwd,input,name});
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
  // AIDEV-NOTE: Shell может содержать непрозрачный код; он не создаёт область и не переписывается.
  if (!['apply_patch', 'Write', 'Edit'].includes(name)) return deny('Используйте native файловую запись для подготовки области.');
  const key = env.CODEWORKS_WORKSPACE_KEY;
  if (!event.session_id || !event.turn_id || !event.tool_use_id) return deny('Для записи нужны идентификаторы сессии и вызова.');
  let rewrite;
  if (name === 'apply_patch') {
    const field = typeof input === 'string' ? null : typeof input?.command === 'string' ? 'command' : typeof input?.patch === 'string' ? 'patch' : null;
    const value = field ? input[field] : input;
    if (typeof value !== 'string' || !/^\*\*\* Begin Patch\r?\n/.test(value) || !/\*\*\* End Patch\r?\n?$/.test(value)) return deny('Не удалось однозначно разобрать patch.');
    const headers = [...value.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)];
    if (!headers.length || headers.length !== files.length || /^\*\*\* (?!Begin Patch|End Patch|End of File|Add File: |Update File: |Delete File: |Move to: ).+$/m.test(value)) return deny('Не удалось однозначно разобрать patch.');
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
  const kind = env.CODEWORKS_WORKSPACE_KIND;
  const payload = hash({tool_name:event.tool_name, tool_input:input, cwd, project_id:project.id, workspace_key:key, kind});
  const args = {project_id:project.id, ...(key ? {workspace_key:key} : {}), ...(kind ? {kind} : {}), session_id:event.session_id, turn_id:event.turn_id, tool_use_id:event.tool_use_id, tool_name:event.tool_name, payload_sha256:payload, targets:[...new Set(files.map(f=>path.relative(root,f)))], request_key:'hook-'+hash([project.id,key,kind,event.session_id,event.turn_id,event.tool_use_id]).slice(0,48)};
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
    return {hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'allow', updatedInput, additionalContext:`Запись перенаправлена в область Codeworks ${result.workspace_key}: ${result.path}; ветка ${result.branch}; workspace_id=${result.workspace_id}. Продолжайте работу в этом дереве.`}};
  } catch (error) {
    if (client) try { await client.call('write.stop', {project_id:project.id,session_id:event.session_id,turn_id:event.turn_id,event:'Stop',...(result?.write_call_id ? {write_call_id:result.write_call_id} : {tool_use_id:event.tool_use_id}),reason:'prepare_pending'}); } catch {}
    return deny(hookFailure(error));
  }
  finally { try { await client?.close(); } catch {} }
}

// AIDEV-NOTE: Для shell сохраняется незавершённая запись до независимой проверки процессов.
async function existingWrite(event, area, {env,connect,files,shell,cwd,input,name}) {
  const deny = message => denied(message,[area.project]);
  if (!event.session_id || !event.turn_id || !event.tool_use_id) return deny('Нет идентификаторов вызова записи.');
  if ((!shell && !['apply_patch','Write','Edit'].includes(name)) || files.some(f=>!inside(area.root,f))) return deny('Разделите запись по владельцам.');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let client,result;
  try {
    client = await connect(await loadClientConfig(env));
    const status = await client.call('status',{project_id:area.project.id,workspace_id:area.id});
    const w = status.workspace;
    if (!w || resolved(w.path,'/') !== area.root || w.preparation_state !== 'ready') return deny('Рабочая область недоступна.');
    const key=w.workspace_key,kind=w.kind;
    const args={project_id:area.project.id,workspace_id:area.id,workspace_key:key,kind,session_id:event.session_id,turn_id:event.turn_id,tool_use_id:event.tool_use_id,tool_name:event.tool_name,payload_sha256:hash({tool_name:event.tool_name,tool_input:input,cwd,project_id:area.project.id,workspace_id:area.id}),targets:files.length ? [...new Set(files.map(f=>path.relative(area.root,f)))] : ['.'],request_key:'hook-'+hash([area.project.id,key,kind,event.session_id,event.turn_id,event.tool_use_id]).slice(0,48)};
    result=await client.call('write.begin',args);
    if (result.workspace_id!==area.id || resolved(result.path,'/')!==area.root) throw Error('WORKSPACE_MISMATCH');
    await client.call('write.admit',{project_id:area.project.id,write_call_id:result.write_call_id,rewritten_sha256:hash(input)});
    return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}};
  } catch (error) {
    if (client) try { await client.call('write.stop',{project_id:area.project.id,session_id:event.session_id,turn_id:event.turn_id,event:'Stop',...(result?.write_call_id ? {write_call_id:result.write_call_id} : {tool_use_id:event.tool_use_id}),reason:'prepare_pending'}); } catch {}
    return deny(hookFailure(error));
  } finally { try { await client?.close(); } catch {} }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runHook(await readJSON(process.stdin))) + '\n'); }
  catch { process.stderr.write('Codeworks hook: invalid hook input.\n'); process.exitCode = 1; }
}
