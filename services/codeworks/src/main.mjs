// ABOUTME: Запускает один сервис Codeworks с NATS API и восстановлением намерений.
// ABOUTME: Серверные адреса и credentials передаются конфигурацией, не входят в продукт.
import { connect, credsAuthenticator } from 'nats';
import { readFile } from 'node:fs/promises';
import { startRuntime } from './runtime.mjs';
import { runNats } from './nats.mjs';
let runtime,nc,service;
try {
  runtime=await startRuntime({databaseURL:process.env.CODEWORKS_DATABASE_URL,adminExecutor:process.env.CODEWORKS_ADMIN_EXECUTOR});
  if(!process.env.CODEWORKS_NATS_URL||!process.env.CODEWORKS_NATS_CREDS_FILE)throw new Error('NATS_CONFIGURATION_REQUIRED');
  nc=await connect({servers:process.env.CODEWORKS_NATS_URL,authenticator:credsAuthenticator(await readFile(process.env.CODEWORKS_NATS_CREDS_FILE)),name:'service_codeworks',maxReconnectAttempts:-1});
  service=await runNats(nc,runtime,(process.env.CODEWORKS_EXECUTORS??'').split(',').filter(Boolean));
  console.log('codeworks ready');
  await Promise.race([nc.closed(),new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);})]);
} catch {console.error('codeworks service failed');process.exitCode=1;}
finally {await service?.stop();await runtime?.close();await nc?.drain();}
