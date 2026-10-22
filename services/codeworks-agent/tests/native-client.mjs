// ABOUTME: Управляет реальным app-server protocol в изолированной приёмке.
// ABOUTME: Не эмулирует модель или инструменты; native frames остаются настоящими.
import {WebSocket} from 'ws';
/** Открывает реальный native endpoint и ограничивает RPC/turn ожидания. */
export async function nativeClient(state) {
  const ws=new WebSocket('ws+unix://'+state+'/codex-app.sock:/'),pending=new Map(),events=[];let id=0;
  ws.on('message',data=>{const f=JSON.parse(data);if(pending.has(f.id)){const p=pending.get(f.id);pending.delete(f.id);f.error?p.reject(new Error(JSON.stringify(f.error))):p.resolve(f.result);}else events.push(f);});
  ws.on('close',()=>{for(const p of pending.values())p.reject(new Error('NATIVE_CONNECTION_CLOSED'));pending.clear();});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  function call(method,params){const i=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(i);reject(new Error('NATIVE_RPC_TIMEOUT '+method));},120000);pending.set(i,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id:i,method,params}));});}
  async function until(predicate){const end=Date.now()+180000;while(Date.now()<end){const result=events.find(predicate);if(result)return result;await new Promise(r=>setTimeout(r,50));}throw new Error('NATIVE_TURN_TIMEOUT');}
  await call('initialize',{clientInfo:{name:'codeworks_real_handoff',version:'1.0.0'}});ws.send(JSON.stringify({method:'initialized'}));
  return {call,events,until,close(){ws.close();setTimeout(()=>ws.terminate(),500).unref();},
    /** Выполняет настоящий model turn и возвращает его финальный текст/frames. */
    async turn(thread,prompt){events.length=0;const {turn}=await call('turn/start',{threadId:thread,input:[{type:'text',text:prompt}]});const result=await until(f=>f.method==='turn/completed'&&f.params.turn.id===turn.id);if(result.params.turn.status!=='completed')throw new Error('NATIVE_TURN_FAILED');const messages=events.filter(f=>f.method==='item/completed'&&f.params.item.type==='agentMessage');return messages.at(-1)?.params.item.text??'';},
  };
}
