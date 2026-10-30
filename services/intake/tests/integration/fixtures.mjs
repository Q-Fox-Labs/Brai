// ABOUTME: Ограничивает реальные интеграционные подключения disposable loopback окружением.
// ABOUTME: Не читает .env; production endpoints и чужие Temporal namespaces запрещены.
export function integrationConfig(){
 if(process.env.INTAKE_TEST_DISPOSABLE!=='1')return null;
 const databaseUrl=process.env.INTAKE_TEST_DATABASE_URL,ownerUrl=process.env.INTAKE_TEST_OWNER_DATABASE_URL,natsUrl=process.env.INTAKE_TEST_NATS_URL;
 if(!databaseUrl||!ownerUrl||!natsUrl)throw Error('MISSING_TEST_CONFIG');
 for(const text of [databaseUrl,ownerUrl]){const u=new URL(text);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/brai_intake_test')throw Error('DISPOSABLE_DATABASE_REQUIRED');}
 const n=new URL(natsUrl);if(!['127.0.0.1','localhost'].includes(n.hostname)||!n.port||n.port==='4222')throw Error('DISPOSABLE_BROKER_REQUIRED');
 return {databaseUrl,ownerUrl,natsUrl,role:process.env.INTAKE_TEST_ROLE??'intake_test',temporalAddress:process.env.INTAKE_TEST_TEMPORAL_ADDRESS??'127.0.0.1:7233',temporalNamespace:'intake_test'};
}
