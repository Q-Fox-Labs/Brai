// ABOUTME: Проверяет test-only endpoints по защищённому UUID proof или прежнему loopback guard.
// ABOUTME: Не принимает произвольный путь proof и не выполняет сетевых операций.
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const base='/var/lib/brai-tests/bug-hunt-stage3';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Возвращает Root proof по canonical UUID; отсутствие UUID сохраняет прежний loopback режим. */
export function fixtureNetwork(run=process.env.BUG_HUNT_FIXTURE_RUN){
 if(run===undefined)return null;
 assert.match(run,uuid);
 const file=join(base,run,'fixture-network.json');
 for(let path=dirname(file);;path=dirname(path)){
  const st=lstatSync(path);assert.ok(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o022)===0);
  if(path==='/')break;
 }
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const st=fstatSync(fd);assert.ok(st.isFile()&&st.uid===0&&(st.mode&0o222)===0);
  const proof=JSON.parse(readFileSync(fd,'utf8'));assert.equal(proof.version,1);assert.equal(proof.run,run);
  assert.match(proof.networkId,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(proof.services).sort(),['nats','postgres','temporal','temporal-db']);
  for(const [name,port] of Object.entries({postgres:5432,nats:4222,'temporal-db':5432,temporal:7233})){
   const entry=proof.services[name];assert.match(entry.cid,/^[a-f0-9]{64}$/);assert.match(entry.image,/^sha256:[a-f0-9]{64}$/);
   assert.match(entry.ip,/^(?:\d{1,3}\.){3}\d{1,3}$/);assert.equal(entry.port,port);
  }
  return proof;
 }finally{closeSync(fd);}
}
/** Проверяет реально прочитанный URL БД до создания Pool. */
export function fixtureDatabase(value,role,database,proof){
 const u=new URL(value);assert.ok(['postgres:','postgresql:'].includes(u.protocol));
 assert.equal(u.hostname,proof?proof.services.postgres.ip:'127.0.0.1');
 if(proof){assert.equal(u.port,'5432');assert.equal(u.username,'bug_hunt_'+role);}
 assert.equal(u.pathname,'/'+database);assert.equal(u.search,'');assert.equal(u.hash,'');return u;
}
/** Проверяет NATS, Temporal и namespace того же proof до подключения. */
export function fixtureServices(nats,address,namespace,proof){
 const u=new URL(nats);assert.equal(u.protocol,'nats:');assert.equal(u.hostname,proof?proof.services.nats.ip:'127.0.0.1');
 if(proof){assert.equal(u.port,'4222');assert.equal(u.username,'');assert.equal(u.password,'');assert.equal(u.pathname,'');assert.equal(u.search,'');assert.equal(u.hash,'');assert.equal(address,proof.services.temporal.ip+':7233');assert.equal(namespace,'bug-hunt-test-'+proof.run);}
 else {assert.match(address,/^127\.0\.0\.1:[1-9]\d{0,4}$/);assert.match(namespace,/^bug-hunt-test-[a-z0-9-]+$/);}
 return u;
}
