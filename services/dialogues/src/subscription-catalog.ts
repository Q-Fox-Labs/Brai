// ABOUTME: Получает актуальный каталог подписки для собственного исполнителя Luna.
// ABOUTME: Access живёт только в памяти; файл содержит только метаданные моделей.
import {rename,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {DialoguesFault} from './domain.js';
import {credential,type SubscriptionConfig} from './subscription-luna.js';
/** Подготавливает каталог при закрытом допуске; общий config Codex не меняется. */
export async function prepareSubscriptionCatalog(cfg:SubscriptionConfig){
 const {stdout}=await promisify(execFile)(cfg.binary,['--version'],{env:{PATH:cfg.node?cfg.node.slice(0,cfg.node.lastIndexOf('/'))+':/usr/bin:/bin':'/usr/bin:/bin'}});
 const version=stdout.trim().split(/\s+/).at(-1);
 if(!version||!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version))throw new DialoguesFault('LUNA_CLI_UNAVAILABLE');
 const value=await credential(cfg.credentialSocket);
 if(value?.sourceRef!==cfg.sourceRef||value.baseUrl!=='https://chatgpt.com/backend-api/codex'||typeof value.access!=='string'||typeof value.accountId!=='string')throw new DialoguesFault('LUNA_AUTH_UNAVAILABLE');
 let catalog:any;
 try{
  const reply=await fetch(value.baseUrl+'/models?client_version='+encodeURIComponent(version),{headers:{Authorization:'Bearer '+value.access,'ChatGPT-Account-Id':value.accountId,'User-Agent':'brai-dialogues/'+version,originator:'codex_cli_rs'},redirect:'error'});
  if(!reply.ok)throw new DialoguesFault('LUNA_CATALOG_UNAVAILABLE');
  catalog=await reply.json();
 }finally{delete value.access;}
 if(!Array.isArray(catalog?.models)||!catalog.models.some((m:any)=>m.slug==='gpt-6-luna'))throw new DialoguesFault('LUNA_NOT_AVAILABLE');
 const temporary=cfg.catalogPath+'.'+randomUUID();
 try{
  await writeFile(temporary,JSON.stringify(catalog),{mode:0o600,flag:'wx'});
  await rename(temporary,cfg.catalogPath);
 }finally{await rm(temporary,{force:true});}
}
