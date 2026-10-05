// ABOUTME: Запускает отдельный процесс ядра для межпроцессных проверок.
// ABOUTME: Допускает только явно заданную временную PostgreSQL БД и собственный FS root.
import {Pool} from "pg";
import {writeFile} from "node:fs/promises";
import {createArtifactsCore} from "../../dist/core.js";
import {createPostgresStore} from "../../dist/postgres.js";
import {createFileStore} from "../../dist/files.js";
const url=new URL(process.env.ARTIFACTS_TEST_WORKER_URL);if(url.hostname!=="127.0.0.1"||url.port!=="25541"||!/^\/brai_artifacts_test_[a-z0-9_]+$/.test(url.pathname))throw new Error("Refusing non-fixture database");
const payload=JSON.parse(process.env.ARTIFACTS_TEST_PAYLOAD),pool=new Pool({connectionString:url.href,connectionTimeoutMillis:1000});
const files=await createFileStore(process.env.ARTIFACTS_TEST_ROOT);
const mode=process.env.ARTIFACTS_TEST_MODE;
if(mode==="crash-after-publish"||mode==="crash-before-publish"){const publish=files.publish;files.publish=async(...args)=>{if(mode==="crash-after-publish")await publish(...args);process.exit(47);};}
if(mode==="crash-after-unlink"){const remove=files.remove;files.remove=async(...args)=>{await remove(...args);process.exit(48);};}
const core=createArtifactsCore({store:createPostgresStore(pool),files,config:{uploadBaseURL:"http://fixture",internalBaseURL:"http://internal",externalBaseURL:"https://share.invalid",maxUploadBytes:1048576,staleTempAgeMs:1000,reconcileBatchSize:2}});
try{
  let result;
  if(mode.includes("upload")||mode.includes("publish"))result=await core.upload(payload.token,(async function*(){if(payload.marker){await writeFile(payload.marker,"started");await new Promise(resolve=>setTimeout(resolve,300));}yield Buffer.from(payload.value??"worker upload");})());
  else if(mode==="crash-after-unlink")result=await core.execute("delete",payload);
  else result=await core.execute(mode,payload);
  console.log(JSON.stringify({result}));
}catch(error){console.log(JSON.stringify({error:error.code??"UNKNOWN"}));}
finally{await pool.end();}
