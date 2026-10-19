// ABOUTME: Собирает v0/v1 NATS, PG journal и один LiteLLM egress в одной программе.
// ABOUTME: Без PG запускает только прежний v0; миграции и платный health не выполняет.
import { artifactsPort } from "./artifacts.js";
import { connect } from "nats";
import { registerProviders } from "./nats.js";
import { registerProvidersV1 } from "./nats-v1.js";
import { createEgressGuard } from "./egress.js";
import { liteLLMPort, liteLLMDecidePort, liteLLMChatPort, liteLLMImagePort } from "./http.js";
import { postgresStore } from "./postgres.js";
import { createOperations } from "./operations.js";
import { createObservation, historySender, OBSERVATION_LIMITS } from "./observation.js";
import { postgresObservation } from "./observation-postgres.js";
const { NATS_URL, LITELLM_URL, PROVIDERS_DATABASE_URL, LITELLM_API_KEY }=process.env;
if(!NATS_URL || !LITELLM_URL)throw new Error("MISSING_RUNTIME_CONFIGURATION");
const store=PROVIDERS_DATABASE_URL?postgresStore(PROVIDERS_DATABASE_URL):undefined;
if(store){await store.exclusive(()=>process.exit(1));await store.recover(Date.now());await store.sweep(Date.now());}
const guard=await createEgressGuard({host:"127.0.0.1",port:Number(process.env.PROVIDERS_EGRESS_PORT ?? "18401")});
const nc=await connect({servers:NATS_URL,user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD,inboxPrefix:process.env.NATS_INBOX_PREFIX,maxReconnectAttempts:0,reconnect:false,maxPingOut:2,timeout:3000});
const observationStore=PROVIDERS_DATABASE_URL?postgresObservation(PROVIDERS_DATABASE_URL):undefined;
const js=nc.jetstream();
const observation=observationStore?createObservation(observationStore,historySender(nc),event=>js.publish('brai.alerts.v1.ingest',new TextEncoder().encode(JSON.stringify(event)),{msgID:event.id,timeout:OBSERVATION_LIMITS.timeoutMs}),()=>!nc.isClosed()):undefined;
const operations=store?createOperations(store,liteLLMDecidePort(LITELLM_URL,guard,LITELLM_API_KEY),{deadlineMs:Number(process.env.PROVIDERS_JEV_DEADLINE_MS ?? "30000"),chatPort:liteLLMChatPort(LITELLM_URL,guard,LITELLM_API_KEY),chatDeadlineMs:Number(process.env.PROVIDERS_CHAT_DEADLINE_MS??"90000"),imagePort:liteLLMImagePort(LITELLM_URL,guard,LITELLM_API_KEY),artifacts:process.env.PROVIDERS_ARTIFACTS_INTERNAL_ORIGIN&&process.env.PROVIDERS_ARTIFACTS_UPLOAD_ORIGIN?artifactsPort(nc,{internalOrigin:process.env.PROVIDERS_ARTIFACTS_INTERNAL_ORIGIN,uploadOrigin:process.env.PROVIDERS_ARTIFACTS_UPLOAD_ORIGIN}):undefined}):undefined;
await operations?.resumeOutputs();
const v0=await registerProviders(nc,liteLLMPort(LITELLM_URL,guard,LITELLM_API_KEY));
await observation?.tick();
const v1=operations?await registerProvidersV1(nc,operations,{inboxPrefix:process.env.PROVIDERS_INBOX_PREFIX,diagnostics:()=>observation!.status()}):undefined;
const observe=observation?setInterval(()=>{void observation.tick();},OBSERVATION_LIMITS.pollMs):undefined;observe?.unref();
const sweep=store?setInterval(()=>{void store.sweep(Date.now()).catch(()=>{console.error('{"code":"STORAGE_UNAVAILABLE"}');});},60000):undefined;sweep?.unref();
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{
  if(sweep)clearInterval(sweep);
  if(observe)clearInterval(observe);observation?.stop();
  void Promise.all([v0.stop(),v1?.stop()]).then(()=>operations?.idle()).then(()=>nc.drain()).finally(async()=>{await guard.close();await observationStore?.close();await store?.close();});
});
console.log(JSON.stringify({service:"brai_providers",version:store?"1.0.0":"0.0.1",protocols:store?["v0","v1"]:["v0"],status:"started"}));
