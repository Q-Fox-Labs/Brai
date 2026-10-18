// ABOUTME: Собирает v0/v1 NATS, PG journal и один LiteLLM egress в одной программе.
// ABOUTME: Без PG запускает только прежний v0; миграции и платный health не выполняет.
import { connect } from "nats";
import { registerProviders } from "./nats.js";
import { registerProvidersV1 } from "./nats-v1.js";
import { createEgressGuard } from "./egress.js";
import { liteLLMPort, liteLLMDecidePort } from "./http.js";
import { postgresStore } from "./postgres.js";
import { createOperations } from "./operations.js";
const { NATS_URL, LITELLM_URL, PROVIDERS_DATABASE_URL }=process.env;
if(!NATS_URL || !LITELLM_URL)throw new Error("MISSING_RUNTIME_CONFIGURATION");
const store=PROVIDERS_DATABASE_URL?postgresStore(PROVIDERS_DATABASE_URL):undefined;
if(store){await store.exclusive(()=>process.exit(1));await store.recover(Date.now());await store.sweep(Date.now());}
const guard=await createEgressGuard({host:"127.0.0.1",port:Number(process.env.PROVIDERS_EGRESS_PORT ?? "18401")});
const nc=await connect({servers:NATS_URL,maxReconnectAttempts:0,reconnect:false,maxPingOut:2,timeout:3000});
const operations=store?createOperations(store,liteLLMDecidePort(LITELLM_URL,guard),{deadlineMs:Number(process.env.PROVIDERS_JEV_DEADLINE_MS ?? "30000")}):undefined;
const v0=await registerProviders(nc,liteLLMPort(LITELLM_URL,guard));
const v1=operations?await registerProvidersV1(nc,operations):undefined;
const sweep=store?setInterval(()=>{void store.sweep(Date.now()).catch(()=>{console.error('{"code":"STORAGE_UNAVAILABLE"}');});},60000):undefined;sweep?.unref();
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{
  if(sweep)clearInterval(sweep);
  void Promise.all([v0.stop(),v1?.stop()]).then(()=>operations?.idle()).then(()=>nc.drain()).finally(async()=>{await guard.close();await store?.close();});
});
console.log(JSON.stringify({service:"brai_providers",version:store?"1.0.0":"0.0.1",protocols:store?["v0","v1"]:["v0"],status:"ready"}));
