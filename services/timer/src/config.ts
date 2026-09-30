// ABOUTME: Читает явную конфигурацию процесса из окружения.
// ABOUTME: Не читает файлы admin или секреты других приложений.
function positive(env: NodeJS.ProcessEnv,name:string,fallback:number){const value=Number(env[name]??fallback);if(!Number.isSafeInteger(value)||value<=0)throw new Error(`INVALID_${name}`);return value;}
/** Требует URL БД/NATS и возвращает закреплённые пределы с явными overrides. */
export function config(env: NodeJS.ProcessEnv=process.env){
 if(!env.DATABASE_URL||!env.NATS_URL)throw new Error("DATABASE_URL_AND_NATS_URL_REQUIRED");
 return {databaseURL:env.DATABASE_URL,natsURL:env.NATS_URL,natsUser:env.NATS_USER,natsPassword:env.NATS_PASSWORD,inboxPrefix:env.NATS_INBOX_PREFIX??"_INBOX.brai_timer",commandMaxBytes:positive(env,"TIMER_COMMAND_MAX_BYTES",256*1024*1024),eventMaxBytes:positive(env,"TIMER_EVENT_MAX_BYTES",64*1024*1024),eventMaxAgeMs:positive(env,"TIMER_EVENT_MAX_AGE_MS",7*24*60*60*1000),ackWaitMs:positive(env,"TIMER_ACK_WAIT_MS",30000)};
}
export type Config=ReturnType<typeof config>;
