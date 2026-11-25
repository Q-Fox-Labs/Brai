// ABOUTME: Подключает Providers к NATS с восстановлением после обрыва.
// ABOUTME: Не повторяет команды или запросы к модели.
import {connect,type ConnectionOptions,type NatsConnection} from 'nats';

/** Открывает соединение с проверенными параметрами runtime. */
export function connectBroker(options:ConnectionOptions):Promise<NatsConnection>{
  return connect({...options,maxReconnectAttempts:-1,maxPingOut:2,timeout:3000});
}

/** Проверяет синхронное состояние transport закреплённого NATS 2.29.3; неизвестную реализацию закрывает. */
export function canSend(nc:Pick<NatsConnection,'isClosed'>):boolean{
  const transport=nc as typeof nc & {protocol?:{connected?:unknown}};
  return !nc.isClosed()&&transport.protocol?.connected===true;
}

/** Следит за связью и закрывает её при остановке во время обрыва. */
export function monitorBroker(nc:NatsConnection){
  let connected=true,stopping=false;
  const closeIfStopping=()=>{if(stopping&&!canSend(nc)&&!nc.isClosed())void nc.close().catch(()=>{});};
  void (async()=>{
    try {for await(const event of nc.status()){
      if(event.type==='disconnect'){connected=false;closeIfStopping();}
      if(event.type==='reconnect')connected=true;
    }} finally {connected=false;closeIfStopping();}
  })().catch(()=>{connected=false;closeIfStopping();});
  return {ready:()=>connected&&canSend(nc),beginShutdown:()=>{stopping=true;closeIfStopping();}};
}
