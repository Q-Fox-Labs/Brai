// ABOUTME: Запускает приёмку finalization только с явной disposable инфраструктурой.
// ABOUTME: Исключает одновременные fixture и проверяет неизменность кандидата.
import {spawnSync} from 'node:child_process';

const names=['config','temporal-address','temporal-namespace','qdrant-url','candidate-sha'];
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  const key=args[i]?.replace(/^--/,'');
  if(!names.includes(key)||options[key]||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENTS');
  options[key]=args[i+1];
}
if(names.some(name=>!options[name])||!/^[a-f0-9]{40}$/.test(options['candidate-sha']))throw Error('INVALID_ARGUMENTS');
const address=options['temporal-address'];
if(!/^127\.0\.0\.1:\d+$/.test(address))throw Error('LOCAL_TEMPORAL_REQUIRED');
const qdrant=new URL(options['qdrant-url']);
if(qdrant.protocol!=='http:'||qdrant.hostname!=='127.0.0.1'||!qdrant.port||qdrant.pathname!=='/'||qdrant.search||qdrant.hash||qdrant.username||qdrant.password)throw Error('LOCAL_QDRANT_FIXTURE_REQUIRED');
process.env.CODEWORKS_TEST_CONFIG_FILE=options.config;
const {readConfig}=await import('../tests/integration/fixture.mjs');
const config=await readConfig();
if(config.fixture!=='temporal')throw Error('TEMPORAL_FIXTURE_REQUIRED');
const head=()=>{
  const result=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
  if(result.status!==0||result.stdout.trim()!==options['candidate-sha'])throw Error('CANDIDATE_SHA_MISMATCH');
};
head();
const env={...process.env,CODEWORKS_TEST_CONFIG_FILE:options.config,CODEWORKS_TEMPORAL_ADDRESS:address,CODEWORKS_TEMPORAL_NAMESPACE:options['temporal-namespace'],CODEWORKS_INDEX_QDRANT:qdrant.origin,CODEWORKS_FINALIZATION_ACCEPTANCE:'1'};
const result=spawnSync('/usr/bin/flock',['-x','/tmp/codeworks-temporal-fixture.lock',process.execPath,'--test','--test-concurrency=1','services/codeworks/tests/integration/write-admission-finalization.test.mjs','services/codeworks/tests/integration/write-admission-session.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-ledger.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-route.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-retry.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-dispositions.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-archive.test.mjs','services/codeworks/tests/integration/lifecycle-finalization-branch.test.mjs','services/codeworks/tests/integration/lifecycle-finalization.test.mjs'],{env,stdio:'inherit'});
head();
if(result.error)throw result.error;
if(result.status!==0)process.exitCode=result.status??1;
