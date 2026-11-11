// ABOUTME: Продолжает проверку через короткие Activities и долговечные ожидания Temporal.
// ABOUTME: History содержит только ID и безопасные коды; внешний I/O остаётся в Activities.
import {proxyActivities,defineSignal,setHandler,condition,continueAsNew} from "@temporalio/workflow";
interface Activities {advance(id:string):Promise<{terminal:boolean;wait_ms:number;code:string}>}
const {advance}=proxyActivities<Activities>({startToCloseTimeout:"2 minutes",heartbeatTimeout:"15 seconds",retry:{maximumAttempts:1}});
export const wake=defineSignal("wake");
/** Допущенный ID остаётся прежним после retry, restart и Continue-As-New. */
export async function verificationWorkflow(id:string):Promise<void>{
 let awakened=false;setHandler(wake,()=>{awakened=true;});
 for(let step=0;step<256;step++){
  awakened=false;let result;
  try{result=await advance(id);}catch{result={terminal:false,wait_ms:60000,code:"ACTIVITY_UNAVAILABLE"};}
  if(result.terminal)return;
  await condition(()=>awakened,Math.max(1,Math.min(result.wait_ms,60000)));
 }
 await continueAsNew<typeof verificationWorkflow>(id);
}
