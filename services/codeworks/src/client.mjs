// ABOUTME: Предоставляет локальным хукам и CLI тот же NATS API Codeworks.
// ABOUTME: Не читает БД; доверенный executor ограничен broker ACL и политикой проекта.
import {connect,credsAuthenticator} from 'nats';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {methods,validate,outputNames} from './contracts.mjs';
import {Fault} from './errors.mjs';
/** Подключает тонкий клиент по явным параметрам; credentials не попадают в сообщения. */
export async function connectClient({server,credsFile,executorId}) {
  if(!server||!credsFile||!/^[a-z][a-z0-9_]{0,63}$/.test(executorId??''))throw new Error('CODEWORKS_CLIENT_CONFIGURATION_REQUIRED');
  const nc=await connect({servers:server,authenticator:credsAuthenticator(await readFile(credsFile)),name:'codeworks_'+executorId});
  return {
    /** При тайм-ауте повторяется прежний ключ; долгий Git не отменяется. */
    async call(method,args) {
      if(!methods.includes(method))throw new Fault('INVALID_ARGUMENT');
      validate(method,args);
      const bytes=Buffer.from(JSON.stringify(args));if(bytes.length>65536)throw new Fault('INVALID_ARGUMENT');
      const reply=await nc.request('brai.codeworks.v1.'+executorId+'.'+method,bytes,{timeout:10000});
      const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reply.data));
      if(reply.headers?.get('Nats-Service-Error')){validate('error',result);throw new Fault(result.code,result.message);}
      validate(outputNames[method],result);return result;
    },
    /** Освобождает только собственное broker соединение. */
    close:()=>nc.drain(),
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw new Fault('INVALID_ARGUMENT');chunks.push(chunk);}
    client=await connectClient({server:process.env.CODEWORKS_NATS_URL,credsFile:process.env.CODEWORKS_NATS_CREDS_FILE,executorId:process.env.CODEWORKS_EXECUTOR_ID});
    console.log(JSON.stringify(await client.call(process.argv[2],JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch(error) {console.error(error instanceof Fault?JSON.stringify(error.dto()):'Codeworks request failed; retry with the same idempotency key.');process.exitCode=1;}
  finally {await client?.close();}
}
