// ABOUTME: Передаёт закреплённое намерение веб-превью в доверенный адаптер оператора.
// ABOUTME: Не передаёт доказательства или секреты; неизвестный ответ требует последующей сверки.
import {randomUUID} from 'node:crypto';
import {command} from './git.mjs';

/** Вызывает одну операцию JSON-RPC; ошибка и недостоверный ответ означают неизвестный исход. */
export function createPreviewAdapter({executable=process.env.CODEWORKS_PREVIEW_ADAPTER,run=command}={}) {
  return async (method, previewId, generation) => {
    if (!executable || !['publish','inspect','remove'].includes(method)) return {status:'unknown'};
    const id=randomUUID();
    try {
      const result=await run(executable,[],{input:JSON.stringify({jsonrpc:'2.0',id,method,params:{preview_id:previewId,generation:Number(generation)}})+'\n',allowFailure:true,timeout:120000});
      if(result.code!==0)return {status:'unknown'};
      const reply=JSON.parse(result.stdout),value=reply.result;
      if(reply.jsonrpc!=='2.0'||reply.id!==id||reply.error||value?.preview_id!==previewId||Number(value.generation)!==Number(generation)||!['ready','absent','failed','pending','unknown'].includes(value.status))return {status:'unknown'};
      return value;
    } catch {return {status:'unknown'};}
  };
}
