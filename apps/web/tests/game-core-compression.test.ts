// ABOUTME: Проверяет ограниченную распаковку графа GameCore на веб-границе.
// ABOUTME: Транспорт и данные подменены синтетическими ответами.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import ts from 'typescript';
class GatewayError extends Error { status:number;code:string;constructor(status:number,code:string) {super(code);this.status=status;this.code=code;} }
const id='00000000-0000-4000-8000-000000000001';
const graph={elements:[{id,parentId:null,revision:id,kind:'goal',status:'active',title:'Test',description:'x'.repeat(600000),input:[],output:[]}],moves:[],resources:[]};
function fixture() {
 let raw=Buffer.from(JSON.stringify(graph)); let reply:unknown={encoding:'gzip-base64',size:raw.length,data:gzipSync(raw).toString('base64')}; const calls:{subject:string;body:unknown}[]=[];
 let mode:'compressed'|'reject'|'ignore'='compressed';
 const nc={isClosed:()=>false,isDraining:()=>false,request:async(subject:string,data:Buffer)=>{
  const body=JSON.parse(data.toString());calls.push({subject,body});
  const rejected=mode==='reject'&&subject.endsWith('.graph')&&!!body.response_encoding;
  const value=rejected?{code:'INVALID_ARGUMENT'}:subject.endsWith('.moves')?{items:[]}:mode==='compressed'?reply:{...graph,elements:[{...graph.elements[0],description:'small'}]};
  return {data:Buffer.from(JSON.stringify(value)),headers:{has:()=>rejected,get:(name:string)=>name==='Nats-Service-Error'?'INVALID_ARGUMENT':'400'}};
 }};
 const source=readFileSync(new URL('../server/game-core.ts',import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const mod:{exports:Record<string,unknown>}={exports:{}};
 new Function('require','module','exports',code)((name:string)=>{if(name==='node:zlib')return {gunzipSync};if(name==='./gateway')return {GatewayError,natsConnection:async()=>nc};throw Error(name);},mod,mod.exports);
 return {load:mod.exports.loadGameCoreBoard as (owner:string)=>Promise<unknown>,calls,set:(value:unknown)=>{reply=value;},legacy:(value:'reject'|'ignore')=>{mode=value;}};
}
test('web requests compressed full graph and preserves all contents',async()=>{
 const f=fixture(), result=await f.load('synthetic-owner') as typeof graph;
 assert.equal(result.elements[0].description,graph.elements[0].description);
 assert.deepEqual(f.calls[0],{subject:'brai.game-core.v1.query.graph',body:{user_id:'synthetic-owner',response_encoding:'gzip-base64'}});
 assert.equal(f.calls[1].subject,'brai.game-core.v1.query.moves');
});
test('web refuses invalid envelopes, size mismatches and invalid compressed payload',async()=>{
 const f=fixture();
 for(const value of [{encoding:'gzip-base64',size:8_388_609,data:'AA=='},{encoding:'gzip-base64',size:1,data:'@@'},{encoding:'gzip-base64',size:1,data:'AA=='},{encoding:'gzip-base64',size:1,data:gzipSync(Buffer.from('{}')).toString('base64')},{encoding:'gzip-base64',size:1,data:gzipSync(Buffer.alloc(8_388_609)).toString('base64')}]) {
  f.set(value);await assert.rejects(f.load('synthetic-owner'),(error:unknown)=>error instanceof GatewayError&&error.code==='BAD_REPLY');
 }
});
test('web remains compatible when an old service rejects or ignores the new option',async()=>{
 for (const mode of ['reject','ignore'] as const) {
  const f=fixture();f.legacy(mode);const result=await f.load('synthetic-owner') as typeof graph;
  assert.equal(result.elements[0].description,'small');
  assert.equal(f.calls.filter(call=>call.subject.endsWith('.graph')).length,mode==='reject'?2:1);
 }
});
