// ABOUTME: Формирует пакет текущей Операции и вызывает принятый сборщик без переписывания правил.
// ABOUTME: Не сохраняет ресурсы и не подтверждает постановку; owner транзакция применяет его результат.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ElementsFault } from './domain.js';

type Value = Record<string, any>;
const root = new URL('../planning/', import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL('baseline.json', root), 'utf8'));
/** Стабильный UUID адаптера; не заменяет собственные UUID нормативного сборщика. */
export function planningId(seed: string): string {
 const h=createHash('sha256').update(seed).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Хеширует канонически отсортированный JSON, включая содержимое входов и ревизию. */
export function digest(value: any): string {
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const serialize=(v:any)=>JSON.stringify(v,null,2)+'\n';
/** Загружает только закреплённые правила, проверяя точные принятые байты. */
export function planningRules(): Record<string,string> {
 const files:Record<string,string>={};
 for(const [name, info] of Object.entries(baseline.files) as [string,Value][]) {
  const content=readFileSync(new URL(name,root),'utf8');
  if(createHash('sha256').update(content).digest('hex')!==info.sha256)throw new ElementsFault('INTERNAL');
  if(name.endsWith('.md'))files[`rules/${name}`]=content;
 }
 return files;
}
/** Собирает из выбранных реальных входов пакет, одинаковый для автора и проверяющего. */
export function planningFiles(element:Value, revision:Value, move:Value, resources:Value[], finish:Value|null):Record<string,string> {
 const fields:Value={};
 for(const key of 'title summary inputs context scope constraints preferences unknowns hypothesis expected_result result_types outputs'.split(' '))fields[key]=['inputs','outputs','result_types'].includes(key)?[]:'';
 Object.assign(fields,revision.fields?.draft??{});
 fields.inputs=resources.map(r=>r.id);
 const rules=planningRules();
 const operation={id:move.id,owner:move.element_id,target:element.id,title:move.title,actor:'agent',purpose:'plan',previous:move.previous_move_id};
 const packet={element:{id:element.id,kind:'Задача',parent:element.parent_id},operation,
  finish:{id:finish?.id??planningId(`${move.id}:finish`),owner:move.element_id,target:element.id},draft:fields,
  resources:resources.map(r=>({id:r.id,name:r.title,content:r.content,state:'given',producer:null})),
  context_files:resources.map(r=>`inputs/${r.id}.md`),rules:Object.keys(rules)};
 return {'packet.json':serialize(packet),...Object.fromEntries(resources.map(r=>[`inputs/${r.id}.md`,r.content])),...rules};
}
/** Выполняет bounded Python-процесс; недоступный runtime/таймаут не считается принятием. */
export function assemble(value:Value):Promise<Value> {
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('runner.py',root))],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1'}});
  let output='',size=0,done=false;
  const finish=(error?:Error,result?:Value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result!);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new ElementsFault('DEADLINE_EXCEEDED'));},4000);
  child.on('error',()=>finish(new ElementsFault('INTERNAL')));
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>524288){child.kill('SIGKILL');finish(new ElementsFault('INVALID_ARGUMENT'));}else output+=chunk;});
  child.stderr.resume();
  child.on('close',code=>{try{const result=JSON.parse(output);if(code||result.error)finish(new ElementsFault('INVALID_ARGUMENT'));else finish(undefined,result);}catch{finish(new ElementsFault('INTERNAL'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(value));
 });
}
