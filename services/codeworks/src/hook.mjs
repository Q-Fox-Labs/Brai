#!/usr/bin/env node
// ABOUTME: Направляет поддержанную запись в подготовленную область Codeworks.
// ABOUTME: Не исполняет shell и не заменяет файловые права sandbox.
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectClient, loadClientConfig} from './client.mjs';
import {validateSpool,saveNotice,ackNotice,rawHash,canonicalHash} from './write-notice.mjs';

/** Читает потоковый hook JSON; большой tool_response проверяет и не сохраняет. */
export async function readHookJSON(input) {
  const decoder=new TextDecoder('utf-8',{fatal:true}), max=16*1024*1024, frames=[];
  let output='', size=0, mode='idle', token='', capture=false, captureOverflow=false, captureKey=false, escape=false, unicode='', literal='', number='', root='value', skip=false, skipDepth=0, response=null, responseType=null;
  function top(){return frames.at(-1);}
  function expectingValue(){const f=top();return f?f.kind==='object'?f.state==='value':['value','valueOrEnd'].includes(f.state):root==='value';}
  function append(c){if(skip)return;size+=Buffer.byteLength(c);if(size>max)throw Error('HOOK_INPUT_INVALID_OR_OVERSIZED');output+=c;}
  function responseField(){const f=top();return skip && frames.length===skipDepth+1 && f?.kind==='object' && f.state==='value' ? f.key : null;}
  function begin(){
    if(!expectingValue())throw Error('INVALID_JSON');
    const f=top();if(!skip && frames.length===1 && f?.kind==='object' && f.key==='tool_response'){
      skip=true;skipDepth=frames.length;response=null;responseType=null;output+='null';size+=4;
    }
  }
  function valueDone(value,primitive=true){
    const f=top();
    if(skip && frames.length===skipDepth+1 && f?.kind==='object' && f.state==='value' && ['isError','error','exit_code','status','session_id','sessionId'].includes(f.key)) {
      if(responseType==='object')response[f.key]=primitive?value:true;
    }
    if(f){if(f.kind==='object' && f.state==='value')f.state='commaOrEnd';else if(f.kind==='array'&&['value','valueOrEnd'].includes(f.state))f.state='commaOrEnd';else throw Error('INVALID_JSON');}
    else {if(root!=='value')throw Error('INVALID_JSON');root='done';}
    if(skip && frames.length===skipDepth){skip=false;}
  }
  function finishString(){
    let value;
    if(capture){if(captureOverflow)value='x';else try{value=JSON.parse(token);}catch{throw Error('INVALID_JSON');}}
    const f=top();
    if(f?.kind==='object' && ['key','keyOrEnd'].includes(f.state)){if(f.seen.has(value))throw Error('INVALID_JSON');f.seen.add(value);f.key=value;f.state='colon';}
    else {if(skip&&frames.length===skipDepth&&responseType==='string')response='';valueDone(value);}
    token='';capture=false;
  }
  function decoded(c){}
  function emitScalar(value){if(skip&&frames.length===skipDepth&&responseType===null){responseType='scalar';response=value;}valueDone(value);}
  function consume(c){
    if(mode==='string'){
      append(c);
      if(capture&&!captureOverflow){token+=c;if(token.length>2048){if(captureKey)throw Error('HOOK_INPUT_INVALID_OR_OVERSIZED');captureOverflow=true;token='';}}
      if(unicode){if(!/[0-9a-fA-F]/.test(c))throw Error('INVALID_JSON');unicode+=c;if(unicode.length===5){decoded(String.fromCharCode(parseInt(unicode.slice(1),16)));unicode='';escape=false;}return;}
      if(escape){if(c==='u'){unicode='u';return;}const map={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(map,c))throw Error('INVALID_JSON');decoded(map[c]);escape=false;return;}
      if(c==='\\'){escape=true;return;}if(c==='"'){mode='idle';finishString();return;}if(c.charCodeAt(0)<0x20)throw Error('INVALID_JSON');decoded(c);return;
    }
    if(mode==='number'){
      if(/[0-9eE+.-]/.test(c)){append(c);number+=c;if(number.length>1024)throw Error('INVALID_JSON');return;}
      if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number))throw Error('INVALID_JSON');
      mode='idle';emitScalar(Number(number));number='';consume(c);return;
    }
    if(mode==='literal'){
      append(c);literal+=c;const candidates=['true','false','null'];if(!candidates.some(x=>x.startsWith(literal)))throw Error('INVALID_JSON');
      if(candidates.includes(literal)){mode='idle';emitScalar(JSON.parse(literal));literal='';}return;
    }
    if(/[ \t\r\n]/.test(c)){append(c);return;}
    if(c==='"') {const f=top();if(!(f?.kind==='object'&&['key','keyOrEnd'].includes(f.state)))begin();append(c);startStringNoBegin();return;}
    if(c==='{' || c==='['){begin();append(c);if(skip&&frames.length===skipDepth&&responseType===null){responseType=c==='{'?'object':'array';response=c==='{'?{}:[];}if(frames.length>=64)throw Error('INVALID_JSON');frames.push({kind:c==='{'?'object':'array',state:c==='{'?'keyOrEnd':'valueOrEnd',key:null,seen:new Set()});return;}
    if(c==='}' || c===']'){
      const f=top();if(!f || (c==='}'?f.kind!=='object'||!['keyOrEnd','commaOrEnd'].includes(f.state):f.kind!=='array'||!['valueOrEnd','commaOrEnd'].includes(f.state)))throw Error('INVALID_JSON');
      append(c);frames.pop();const isResponse=skip&&frames.length===skipDepth;valueDone(isResponse?response:true,false);return;
    }
    if(c===':'){const f=top();if(f?.kind!=='object'||f.state!=='colon')throw Error('INVALID_JSON');append(c);f.state='value';return;}
    if(c===','){const f=top();if(!f||f.state!=='commaOrEnd')throw Error('INVALID_JSON');append(c);f.state=f.kind==='object'?'key':'value';return;}
    if(c==='-'||/[0-9]/.test(c)){begin();append(c);mode='number';number=c;return;}
    if('tfn'.includes(c)){begin();append(c);mode='literal';literal=c;return;}
    throw Error('INVALID_JSON');
  }
  function startStringNoBegin(){
    const f=top(),isKey=f?.kind==='object'&&['key','keyOrEnd'].includes(f.state);
    if(!isKey && skip&&frames.length===skipDepth&&responseType===null)responseType='string';
    capture=!!isKey||!!responseField();captureKey=!!isKey;captureOverflow=false;token=capture?'"':'';mode='string';escape=false;unicode='';
  }
  try{
    for await(const chunk of input){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);const text=decoder.decode(bytes,{stream:true});for(const c of text)consume(c);}
    for(const c of decoder.decode())consume(c);
    if(mode==='number'){if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number))throw Error('INVALID_JSON');mode='idle';emitScalar(Number(number));}
    if(mode!=='idle'||frames.length||root!=='done'||skip)throw Error('INVALID_JSON');
    const result=JSON.parse(output);if(responseType!==null)result.tool_response=response;return result;
  }catch{throw Error('HOOK_INPUT_INVALID_OR_OVERSIZED');}
}

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
    if ((c === '~' && !active) || '$`\\*?(){}'.includes(c)) dynamic = true;
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
  if (words[0] === 'git') {
    const action=words[1], args=words.slice(2);
    if (action==='status') return args.every(w=>['--short','-s','--porcelain','--porcelain=v1','--branch','-b','--untracked-files=no'].includes(w));
    if (action==='diff') return args.every(w=>['--stat','--check','--name-only','--no-ext-diff','--no-textconv'].includes(w));
    if (action==='log') return args.every(w=>/^--format=[%a-zA-Z0-9 .:_-]+$/.test(w) || /^-[1-9][0-9]*$/.test(w) || /^--max-count=[1-9][0-9]*$/.test(w) || ['--oneline','--no-decorate'].includes(w));
    if (action==='show') return args.length===1 && /^[0-9a-fA-F]{7,40}:[a-zA-Z0-9_./-]+$/.test(args[0]);
    if (action==='rev-parse') return args.length===1 && args[0]==='HEAD';
    return false;
  }
  if (words[0] === 'pwd') return words.length===1;
  if (words[0] === 'ls') return words.slice(1).every(w=>!w.startsWith('-') || ['-a','-l','-la','-al','-1','--'].includes(w));
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
/** Распознаёт ограниченный набор foreground argv; неизвестные и фоновые команды возвращают false. */
export function foregroundCommand(command) {
  if (typeof command !== 'string') return false;
  const tokens=shellTokens(command);
  if (!tokens.length || tokens.some(t=>t.dynamic)) return false;
  let segment=[];
  const allowed = () => {
    if (!segment.length) return false;
    const words=segment.map(t=>t.word);
    const literal=words.map(w=>"'"+w.replaceAll("'", "'\\''")+"'").join(' ');
    if (readOnlyShell(literal) || synchronousGit(literal)) return true;
    if (words[0]==='rm') {
      let options=true, operands=0;
      for (const word of words.slice(1)) {
        if (options && word==='--') { options=false; continue; }
        if (options && word.startsWith('-')) {
          if (!/^-[frRd]+$/.test(word) && !['--force','--recursive','--dir','--preserve-root','--one-file-system'].includes(word)) return false;
        } else {
          if (!word) return false;
          operands++;
        }
      }
      return operands>0;
    }
    if (words[0]==='cp') {
      const operands=words.slice(1);
      if (operands[0]==='--') operands.shift();
      return operands.length===2 && operands.every(w=>w.length>0 && !w.startsWith('-'));
    }
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
  // AIDEV-NOTE: Native Bash Post передаётся только после завершения процесса; текст stdout не является сигналом состояния.
  return typeof response==='string' && name==='Bash';
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
  catch { return event?.hook_event_name==='PostToolUse' ? {systemMessage:'POST_DELIVERY_UNAVAILABLE: завершение не сохранено; область удерживается для сверки.'} : denied('Невозможно безопасно определить цель записи; проверьте доступ к пути.', []); }
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
    if (!event.session_id || !event.turn_id || (eventName === 'PostToolUse' && !event.tool_use_id)) return eventName==='PostToolUse'?{systemMessage:'POST_DELIVERY_UNAVAILABLE: отсутствует идентификатор вызова.'}:{};
    const shellPost = eventName === 'PostToolUse' && ['Bash','exec_command','write_stdin'].includes(event.tool_name?.split('.').at(-1));
    if (shellPost && (event.tool_input===undefined || event.tool_input===null)) return {systemMessage:'POST_DELIVERY_UNAVAILABLE: отсутствует вход вызова.'};
    const finished = shellPost && completedShell(event);
    // AIDEV-NOTE: Только распознанный завершённый foreground вызов снимает учёт; произвольный shell может оставить потомков.
    if (shellPost && (!foregroundCommand(event.tool_input?.command ?? event.tool_input?.cmd) || !finished)) return {};
    if (eventName === 'PostToolUse') {
      const name=event.tool_name?.split('.').at(-1);
      if (!shellPost && !['apply_patch','Write','Edit','MultiEdit'].includes(name)) return {};
      const input=event.tool_input;
      const cwd=input?.workdir || input?.cwd || event.cwd || process.cwd();
      if (input===undefined || input===null) {
        const scoped=projects.some(p=>[p.repo_path,p.workspace_root].some(root=>typeof root==='string' && path.isAbsolute(root) && inside(resolved(root,'/'),resolved(cwd,'/'))));
        return scoped?{systemMessage:'POST_DELIVERY_UNAVAILABLE: отсутствует вход вызова; область удерживается для сверки.'}:{};
      }
      if (shellPost && readOnlyShell(input?.command ?? input?.cmd)) return {};
      const files=writePaths(event);
      const paths=[...files,...(shellPost?[resolved(cwd,'/')]:[])];
      const ids=[...new Set(projects.filter(project=>{
        const roots=(shellPost?[project.workspace_root]:[project.repo_path,project.workspace_root]).filter(p=>typeof p==='string'&&path.isAbsolute(p)).map(p=>resolved(p,'/'));
        return paths.some(file=>roots.some(root=>inside(root,file)));
      }).map(p=>p.id))];
      if (!ids.length) return {};
      let client,notices=[];
      try {
        validateSpool(config.completion_spool);
        const clientConfig=await loadClientConfig(env);
        const outcome=event.tool_response?.isError || event.tool_response?.error || (Number.isInteger(event.tool_response?.exit_code)&&event.tool_response.exit_code!==0) ? 'error' : 'success';
        for(const project_id of ids){
          const request={project_id,session_id:event.session_id,turn_id:event.turn_id,tool_use_id:event.tool_use_id,tool_name:event.tool_name,input_sha256:rawHash(input),canonical_input_sha256:canonicalHash(input),outcome};
          const notice={version:1,executor_id:clientConfig.executorId,request};
          notices.push({notice,...saveNotice(config.completion_spool,notice)});
        }
        client=await connect(clientConfig);
        let deliveryIssue=null;
        for(const item of notices){
          try {
            const result=await client.call('write.finish',item.notice.request);
            if(!['pending','finished'].includes(result?.state))throw Error('NOTICE_NOT_ACCEPTED');
            ackNotice(config.completion_spool,item.id,item.notice);
          } catch(error) {
            if(error?.code==='WRITE_CALL_MISMATCH')deliveryIssue='POST_DELIVERY_CONFLICT';
            else if(error?.code==='NOT_FOUND' && deliveryIssue!=='POST_DELIVERY_CONFLICT')deliveryIssue='POST_DELIVERY_UNMATCHED';
            else if(!deliveryIssue)deliveryIssue='POST_DELIVERY_PENDING';
          }
        }
        return deliveryIssue?{systemMessage:deliveryIssue+': завершение сохранено; требуется сверка доставки.'}:{};
      } catch (error) {
        const code=error?.message==='WRITE_CALL_MISMATCH'?'POST_DELIVERY_CONFLICT':notices.length===ids.length?'POST_DELIVERY_PENDING':'POST_DELIVERY_UNAVAILABLE';
        return {systemMessage:code+': проверьте доставку завершения; область удерживается для сверки.'};
      } finally {try{await client?.close();}catch{}}
    }
    let client;
    try {
      client = await connect(await loadClientConfig(env));
      for (const id of new Set(projects.map(p=>p.id))) {
        try { await client.call('write.stop',{project_id:id,session_id:event.session_id,turn_id:event.turn_id,event:eventName}); }
        catch { /* Потеря Stop не доказывает завершение активного писателя. */ }
      }
    } catch { /* Stop не снимает неопределённость без подтверждения. */ }
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
  // AIDEV-NOTE: Не допускаем writer, для которого Post и owner verifier не могут подтвердить завершение.
  if (areas.size === 1 && shell && (input?.run_in_background || input?.background || input?.async || !foregroundCommand(input?.command ?? input?.cmd))) {
    return denied('WRITER_COMPLETION_UNSUPPORTED: используйте native файловые инструменты или поддерживаемую команду проверки компонента.', [...areas.values()].map(a=>a.project));
  }
  if (areas.size === 1) {
    try { validateSpool(config.completion_spool); } catch { return denied('POST_DELIVERY_UNAVAILABLE: журнал завершений недоступен.', [...areas.values()].map(a=>a.project)); }
    return existingWrite(event,[...areas.values()][0],{env,connect,files,shell,cwd,input,name});
  }
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
  try { validateSpool(config.completion_spool); } catch { return deny('POST_DELIVERY_UNAVAILABLE: журнал завершений недоступен.'); }
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
    await client.call('write.admit', {project_id:project.id, write_call_id:result.write_call_id, rewritten_sha256:hash(updatedInput), completion_input_sha256:canonicalHash(updatedInput)});
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
    await client.call('write.admit',{project_id:area.project.id,write_call_id:result.write_call_id,rewritten_sha256:hash(input),completion_input_sha256:canonicalHash(input)});
    return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}};
  } catch (error) {
    if (client) try { await client.call('write.stop',{project_id:area.project.id,session_id:event.session_id,turn_id:event.turn_id,event:'Stop',...(result?.write_call_id ? {write_call_id:result.write_call_id} : {tool_use_id:event.tool_use_id}),reason:'prepare_pending'}); } catch {}
    return deny(hookFailure(error));
  } finally { try { await client?.close(); } catch {} }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await runHook(await readHookJSON(process.stdin))) + '\n'); }
  catch { process.stderr.write('HOOK_INPUT_INVALID_OR_OVERSIZED: вызов не подтверждён; завершение Post не сохранено, требуется сверка.\n'); process.exitCode = 2; }
}
