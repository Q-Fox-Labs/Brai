// ABOUTME: Проверяет фактическую готовность БД, схемы и NATS bug-hunt.
// ABOUTME: Не считает PING процесса готовностью и не вызывает модели.
import {pathToFileURL} from "node:url";
import {config} from "./config.js";
import {connectNats} from "./main.js";
/** Запрашивает readiness самого сервиса с проверкой обоих NATS Service Error headers. */
export async function health(){
 const nc=await connectNats(config());
 try{
  const msg=await nc.request("brai.bug_hunt.v1.status",Buffer.from("{}"),{timeout:10000});
  if(msg.headers?.has("Nats-Service-Error")||msg.headers?.has("Nats-Service-Error-Code"))throw new Error();
  const value=JSON.parse(Buffer.from(msg.data).toString());
  if(value.ready!==true||value.nats_ready!==true||value.schema_version!==1)throw new Error();
 }finally{await nc.drain();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await health();console.log("BUG_HUNT_READY");}catch{console.error("BUG_HUNT_NOT_READY");process.exitCode=1;}
}
