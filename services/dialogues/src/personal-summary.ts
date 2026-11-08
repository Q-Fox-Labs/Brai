// ABOUTME: Выполняет свёртку через ограниченный root broker без управляющего socket Codex.
// ABOUTME: Прогресс хранит персональный worker; занятость не является неудачной попыткой.
import {callPersonalBroker} from './personal-auth.js';
import {DialoguesFault,summaryText} from './domain.js';
import type {Execution} from './luna.js';
/** Только фиксированная свёртка; до вызова и выдачи результата проверяется текущий доступ. */
export function createPersonalSummarizer(socket:string,authorize:()=>Promise<void>,call=callPersonalBroker){
 async function run(input:string,state:Execution,save:(state:Execution)=>Promise<void>){
  await authorize();
  if(state.execution_state==='completed'&&state.result)return summaryText(state.result);
  await save({execution_state:'running'});
  const response=await call(socket,'dialogues.summarize',{input},200000);
  await authorize();
  if(response?.status==='busy')throw new DialoguesFault('LUNA_BUSY');
  if(response?.status!=='completed')throw new DialoguesFault('LUNA_EXECUTION_FAILED');
  const result=summaryText(response.result);
  await save({execution_state:'completed',result});return result;
 }
 return {run,async probe(state:Execution={},save: (state:Execution)=>Promise<void>=async()=>{}){
  const result=await run(JSON.stringify({previous_summary:'',original_fragment:'Синтетический факт: бюджет 37 рублей.'}),state,save);
  if(!result.includes('37'))throw new DialoguesFault('LUNA_PROBE_FAILED');
  return {model:'gpt-6-luna',completed:true};
 },async close(){}};
}
