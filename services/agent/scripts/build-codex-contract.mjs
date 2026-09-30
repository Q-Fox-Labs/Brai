// ABOUTME: Собирает локальное замыкание используемых схем Codex 0.159.2.
// ABOUTME: Источник версии и каталог задаются явно; несовпадающие определения останавливают сборку.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const sourceDirectory = valueAfter('--source-directory');
if (!sourceDirectory) throw new Error('Usage: node build-codex-contract.mjs --source-directory <upstream-schema-directory>');
const output = resolve(new URL('../contracts/codex/schema.json', import.meta.url).pathname);
const entries = [
  ['v1/InitializeParams.json','InitializeParams'], ['v1/InitializeResponse.json','InitializeResponse'],
  ...['ThreadStartParams','ThreadStartResponse','ThreadReadParams','ThreadReadResponse','ThreadListParams','ThreadListResponse','ThreadResumeParams','ThreadResumeResponse','ThreadArchiveParams','ThreadArchiveResponse','ThreadUnsubscribeParams','ThreadUnsubscribeResponse','ThreadItemsListParams','ThreadItemsListResponse','ThreadTurnsListParams','ThreadTurnsListResponse','TurnStartParams','TurnStartResponse','TurnSteerParams','TurnSteerResponse','TurnInterruptParams','TurnInterruptResponse'].map(n=>[`v2/${n}.json`,n]),
  ...['TurnStartedNotification','TurnCompletedNotification','ItemStartedNotification','ItemCompletedNotification','AgentMessageDeltaNotification','ThreadStatusChangedNotification','ThreadTokenUsageUpdatedNotification','ServerRequestResolvedNotification','ThreadArchivedNotification','CommandExecutionOutputDeltaNotification','FileChangeOutputDeltaNotification','TurnPlanUpdatedNotification'].map(n=>[`v2/${n}.json`,n]),
  ['CommandExecutionRequestApprovalParams.json','CommandExecutionRequestApprovalParams'],['CommandExecutionRequestApprovalResponse.json','CommandExecutionRequestApprovalResponse'],
  ['ToolRequestUserInputParams.json','ToolRequestUserInputParams'],['ToolRequestUserInputResponse.json','ToolRequestUserInputResponse'],
  ['PermissionsRequestApprovalParams.json','PermissionsRequestApprovalParams'],['PermissionsRequestApprovalResponse.json','PermissionsRequestApprovalResponse'],
  ['FileChangeRequestApprovalParams.json','FileChangeRequestApprovalParams'],['FileChangeRequestApprovalResponse.json','FileChangeRequestApprovalResponse'],
];
const sources = new Map();
const definitions = new Map();
const roots = {};
const queue = [];
const getFile = async (path) => {
  if (!sources.has(path)) { const bytes = await readFile(join(sourceDirectory,path)); sources.set(path,{sha256:createHash('sha256').update(bytes).digest('hex'),schema:JSON.parse(bytes)}); }
  return sources.get(path);
};
for (const [path,name] of entries) {
  const source = await getFile(path);
  const schema = source.schema;
  const root = schema.title === name ? Object.fromEntries(Object.entries(schema).filter(([k])=>k!=='definitions' && k!=='$schema')) : schema.definitions?.[name];
  if (!root) throw new Error(`${path}: missing root ${name}`);
  if (Object.hasOwn(roots,name)) throw new Error(`Duplicate upstream root type: ${name}`);
  roots[name] = root;
  queue.push(...refs(root));
}
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function refs(value) { const found=[]; if(value&&typeof value==='object') for(const [key,child] of Object.entries(value)){if(key==='$ref'&&typeof child==='string'&&child.startsWith('#/definitions/'))found.push(child.slice('#/definitions/'.length)); else found.push(...refs(child));} return [...new Set(found)]; }
// Resolve names against all supplied source documents; recursively retain only referenced definitions.
for (const [path] of entries) await getFile(path);
while (queue.length) {
  const name = queue.shift();
  if (definitions.has(name)) continue;
  const candidates=[];
  for (const [path,record] of sources) if(record.schema.definitions?.[name]) candidates.push([path,record.schema.definitions[name]]);
  if (!candidates.length) { if (roots[name]) continue; throw new Error(`Unresolved upstream definition: ${name}`); }
  const [path,definition]=candidates[0];
  for(const [,candidate] of candidates) if(stable(candidate)!==stable(definition)) throw new Error(`Conflicting upstream definition ${name}; refusing to rename or guess`);
  if (roots[name] && stable(roots[name]) !== stable(definition)) throw new Error(`Upstream root/definition collision for ${name}; refusing to rename or guess`);
  definitions.set(name,definition);
  queue.push(...refs(definition));
}
const schema = {$schema:'http://json-schema.org/draft-07/schema#',title:'Codex app-server 0.159.2 used-boundary schema closure',definitions:{...Object.fromEntries(Object.entries(roots).sort()),...Object.fromEntries([...definitions].sort(([a],[b])=>a.localeCompare(b)))}};
await writeFile(output,`${JSON.stringify(schema,null,2)}\n`);
const manifest={upstreamVersion:'0.159.2',upstreamGeneration:{command:'codex app-server generate-json-schema --experimental --out <output-directory>',binaryVersion:'0.159.2',artifact:'raw WebSocket protocol schema bundle'},generation:'node services/agent/scripts/build-codex-contract.mjs --source-directory <upstream-schema-directory>',sourceFiles:Object.fromEntries([...sources].sort(([a],[b])=>a.localeCompare(b)).map(([path,{sha256}])=>[path,sha256])),rootTypes:entries.map(([,n])=>n),definitionCount:Object.keys(schema.definitions).length};
await writeFile(join(resolve(new URL('../contracts/codex/manifest.json',import.meta.url).pathname)),`${JSON.stringify(manifest,null,2)}\n`);

const openrpcPath = resolve(new URL('../contracts/codex/openrpc.json', import.meta.url).pathname);
const openrpc = JSON.parse(await readFile(openrpcPath,'utf8'));
delete openrpc.paramStructure;
const methodTypes = {'initialize':'InitializeParams','thread/start':'ThreadStartParams','thread/read':'ThreadReadParams','thread/list':'ThreadListParams','thread/resume':'ThreadResumeParams','thread/archive':'ThreadArchiveParams','thread/unsubscribe':'ThreadUnsubscribeParams','thread/items/list':'ThreadItemsListParams','thread/turns/list':'ThreadTurnsListParams','turn/start':'TurnStartParams','turn/steer':'TurnSteerParams','turn/interrupt':'TurnInterruptParams'};
for (const method of openrpc.methods) {
  const type = methodTypes[method.name];
  method.paramStructure = 'by-name';
  if (!type) continue;
  const root = roots[type];
  method.params = Object.keys(root.properties ?? {}).sort().map(field => ({name:field,required:(root.required ?? []).includes(field),schema:{$ref:`schema.json#/definitions/${type}/properties/${field}`}}));
  method['x-paramsSchema'] = {$ref:`schema.json#/definitions/${type}`};
}
await writeFile(openrpcPath,`${JSON.stringify(openrpc,null,2)}\n`);
