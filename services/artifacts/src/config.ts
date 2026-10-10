// ABOUTME: Читает и проверяет runtime-конфигурацию artifacts.
// ABOUTME: Значения приходят только из окружения; секреты не выводятся.
export type Config = {
  databaseURL:string; natsURL:string; natsUser?:string; natsPassword?:string; natsInboxPrefix:string;
  dataDir:string; uploadBaseURL:string; internalBaseURL:string; externalBaseURL?:string;
  httpHost:string; httpPort:number; maxUploadBytes:number; maxConcurrentUploads:number; maxConcurrentNats:number;
  maxNatsRequestBytes:number; maxNatsResponseBytes:number; requestTimeoutMs:number; receiveTimeoutMs:number; uploadTimeoutMs:number;
  reconcileIntervalMs:number; staleTempAgeMs:number; lockTimeoutMs:number; queryTimeoutMs:number;
};
const positive=(env:NodeJS.ProcessEnv,key:string,fallback:number,max=Number.MAX_SAFE_INTEGER)=>{const raw=env[key];if(raw===undefined)return fallback;if(!/^[1-9][0-9]*$/.test(raw))throw new Error(`Invalid ${key}`);const n=Number(raw);if(!Number.isSafeInteger(n)||n>max)throw new Error(`Invalid ${key}`);return n;};
function baseURL(raw:string|undefined,key:string,optional=false){if(!raw&&optional)return undefined;if(!raw)throw new Error(`Missing ${key}`);let url:URL;try{url=new URL(raw);}catch{throw new Error(`Invalid ${key}`);}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error(`Invalid ${key}`);return url.toString().replace(/\/$/,'');}
/** Проверяет обязательные endpoints и конечные лимиты до открытия ресурсов. */
export function loadArtifactsConfig(env:NodeJS.ProcessEnv=process.env):Config {
 const databaseURL=env.ARTIFACTS_DATABASE_URL,natsURL=env.NATS_URL,dataDir=env.ARTIFACTS_DATA_DIR;
 if(!databaseURL)throw new Error('Missing ARTIFACTS_DATABASE_URL');if(!natsURL)throw new Error('Missing NATS_URL');if(!dataDir)throw new Error('Missing ARTIFACTS_DATA_DIR');
 const httpPort=positive(env,'ARTIFACTS_HTTP_PORT',3004);if(httpPort>65535)throw new Error('Invalid ARTIFACTS_HTTP_PORT');const httpHost=env.ARTIFACTS_HTTP_HOST??'127.0.0.1';if(!httpHost||/\s/.test(httpHost))throw new Error('Invalid ARTIFACTS_HTTP_HOST');
 return {databaseURL,natsURL,natsUser:env.NATS_USER,natsPassword:env.NATS_PASSWORD,natsInboxPrefix:env.NATS_INBOX_PREFIX??'_INBOX.brai_artifacts',dataDir,
  uploadBaseURL:baseURL(env.ARTIFACTS_UPLOAD_BASE_URL,'ARTIFACTS_UPLOAD_BASE_URL')!,internalBaseURL:baseURL(env.ARTIFACTS_INTERNAL_BASE_URL,'ARTIFACTS_INTERNAL_BASE_URL')!,externalBaseURL:baseURL(env.ARTIFACTS_EXTERNAL_BASE_URL,'ARTIFACTS_EXTERNAL_BASE_URL',true),
  // AIDEV-NOTE: HTTP shutdown добавляет 1000ms к request timeout; Node переполнение таймера превращает в 1ms.
  httpHost,httpPort,maxUploadBytes:positive(env,'ARTIFACTS_MAX_UPLOAD_BYTES',2*1024*1024*1024,2*1024*1024*1024),maxConcurrentUploads:positive(env,'ARTIFACTS_MAX_CONCURRENT_UPLOADS',4,4),maxConcurrentNats:positive(env,'ARTIFACTS_MAX_CONCURRENT_NATS',32),maxNatsRequestBytes:positive(env,'ARTIFACTS_MAX_NATS_REQUEST_BYTES',128*1024),maxNatsResponseBytes:positive(env,'ARTIFACTS_MAX_NATS_RESPONSE_BYTES',1024*1024),requestTimeoutMs:positive(env,'ARTIFACTS_REQUEST_TIMEOUT_MS',15000,2147482647),uploadTimeoutMs:positive(env,'ARTIFACTS_UPLOAD_TIMEOUT_MS',30*60*1000,2147483647),receiveTimeoutMs:positive(env,'ARTIFACTS_RECEIVE_TIMEOUT_MS',30000,2147483647),reconcileIntervalMs:positive(env,'ARTIFACTS_RECONCILE_INTERVAL_MS',60000,2147483647),staleTempAgeMs:positive(env,'ARTIFACTS_STALE_TEMP_AGE_MS',3600000),lockTimeoutMs:positive(env,'ARTIFACTS_LOCK_TIMEOUT_MS',5000,2147483647),queryTimeoutMs:positive(env,'ARTIFACTS_QUERY_TIMEOUT_MS',10000,2147483647)};
}
