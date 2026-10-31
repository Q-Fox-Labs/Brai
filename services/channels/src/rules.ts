// ABOUTME: Проверяет и вычисляет детерминированные правила канала.
// ABOUTME: Не выполняет SQL, сетевые обращения или пользовательский код.
import {Fault,type Data} from './types.js';
const own=(v:Data,k:string)=>Object.hasOwn(v,k);
/** Отвергает конфликты публикации, включая взаимоисключающие условия. */
export function checkRules(rules:Data[]):void {
 const ids=new Set<string>(),writes=new Set<string>();
 for(const r of rules){
  if(ids.has(r.id))throw new Fault('INVALID_RULE_SET');ids.add(r.id);
  const local=new Set<string>();
  for(const a of r.assign){
   const key=r.priority+'/'+a.field;
   if(local.has(a.field)||writes.has(key))throw new Fault('INVALID_RULE_SET');
   local.add(a.field);writes.add(key);
  }
 }
}
function fact(input:Data,path:string):any {
 const parts=path.split('.');let v:any=input;
 for(const p of parts){if(v===null||typeof v!=='object'||!own(v,p))return undefined;v=v[p];}return v;
}
function matches(c:Data,input:Data):boolean {
 const v=fact(input,c.field);
 if(c.op==='exists')return (v!==undefined&&v!==null)===c.value;
 if(c.op==='equals')return v===c.value;
 return Array.isArray(v)?v.some(x=>c.value.includes(x)):c.value.includes(v);
}
/** Возвращает назначения и их происхождение без изменения исходных фактов. */
export function evaluate(rules:Data[],input:Data,rulesVersion:string):Data {
 const assignments=structuredClone(input.initialFields??{}),fieldOrigins:Data={},appliedRules:Data[]=[];
 for(const key of Object.keys(assignments))fieldOrigins[key]={source:'input',ruleId:null,rulesVersion:null,mode:null};
 const sorted=rules.map((r,i)=>({r,i})).sort((a,b)=>a.r.priority-b.r.priority||a.i-b.i);
 for(const {r}of sorted){
  if(!r.when.every((c:Data)=>matches(c,input)))continue;
  let used=false;
  for(const a of r.assign){
   if(a.mode==='fill_missing'&&own(assignments,a.field))continue;
   assignments[a.field]=structuredClone(a.value);fieldOrigins[a.field]={source:'rule',ruleId:r.id,rulesVersion,mode:a.mode};used=true;
  }
  if(used)appliedRules.push({ruleId:r.id,priority:r.priority,rulesVersion});
 }
 return {assignments,fieldOrigins,appliedRules};
}
