// ABOUTME: Разбирает только явные операторские входы изолированного flow-стенда.
// ABOUTME: Внешний worker получает scope из одного UUIDv4; helper не читает файлы и не подключается к сервисам.
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Выводит synthetic installation/owner/queue из одного canonical UUIDv4; отсутствующий mode создаёт новый local scope. */
export function verificationFlowConfig(environment,makeRun=randomUUID){
 if(['BUG_HUNT_FLOW_INSTALLATION_ID','BUG_HUNT_FLOW_OWNER_ID','BUG_HUNT_FLOW_TASK_QUEUE'].some(key=>environment[key]!==undefined))throw Error('BUG_HUNT_FLOW_SCOPE_MUST_DERIVE_FROM_UUID');
 const flag=environment.BUG_HUNT_FLOW_EXTERNAL_WORKER,externalWorker=flag==='1';
 if(flag!==undefined&&!externalWorker)throw Error('BUG_HUNT_FLOW_EXTERNAL_WORKER_INVALID');
 const explicitRun=environment.BUG_HUNT_FLOW_RUN_UUID;
 if(!externalWorker&&explicitRun!==undefined)throw Error('BUG_HUNT_FLOW_RUN_UUID_REQUIRES_EXTERNAL_WORKER');
 const run=externalWorker?explicitRun:makeRun();
 if(typeof run!=='string'||!uuid.test(run))throw Error('BUG_HUNT_FLOW_RUN_UUID_INVALID');
 const runnerSocket=environment.BUG_HUNT_RUNNER_SOCKET;
 if(runnerSocket!==undefined&&(typeof runnerSocket!=='string'||!isAbsolute(runnerSocket)||runnerSocket.includes('\0')))throw Error('BUG_HUNT_RUNNER_SOCKET_INVALID');
 if(externalWorker&&runnerSocket===undefined)throw Error('BUG_HUNT_RUNNER_SOCKET_REQUIRED');
 return {externalWorker,runnerSocket,run,installationId:'flow-'+run,ownerId:'synthetic-'+run,taskQueue:'bug-hunt-fixture-'+run};
}
/** Сохраняет flow policy и добавляет только принятый Root consumer key во внешнем режиме. */
export function verificationFlowPolicyInput({externalWorker,ownerId}){
 return {enabled:true,revision:'flow-real-recipes',externalAllowedOwners:[ownerId],executor:'codex_app_server',budgets:{dailyCalls:40,ownerDailyCalls:40,dailyTokens:500000},...(externalWorker?{profiles:{codex_app_server:{endpointRef:'bug-hunt-private',revision:'owner-v1'}}}:{})};
}
