// ABOUTME: Проверяет test-only URL guards для Root proof и прежнего loopback режима.
// ABOUTME: Тест не создаёт proof и не подключается к инфраструктуре.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureNetwork,fixtureDatabase,fixtureServices} from './integration/fixture-network.mjs';
const run='1a2b3c4d-1234-4234-9234-123456789abc';
const proof={run,services:{postgres:{ip:'172.30.0.2'},nats:{ip:'172.30.0.3'},temporal:{ip:'172.30.0.4'}}};
const db='postgresql://bug_hunt_owner:fixture-owner@172.30.0.2:5432/brai_bug_hunt_test';
test('attested database guard rejects foreign host, port, role and database',()=>{
 fixtureDatabase(db,'owner','brai_bug_hunt_test',proof);
 for(const [from,to] of [['172.30.0.2','172.30.0.9'],['5432','5433'],['bug_hunt_owner','postgres'],['brai_bug_hunt_test','brai']])
  assert.throws(()=>fixtureDatabase(db.replace(from,to),'owner','brai_bug_hunt_test',proof));
});
test('NATS and Temporal must match the same proof and UUID namespace',()=>{
 const nats='nats://172.30.0.3:4222',address='172.30.0.4:7233',namespace='bug-hunt-test-'+run;
 fixtureServices(nats,address,namespace,proof);
 for(const args of [[nats.replace('.3','.9'),address,namespace],[nats,address.replace('7233','7234'),namespace],[nats,address,'brai']])
  assert.throws(()=>fixtureServices(...args,proof));
});
test('without proof only the existing loopback mode is accepted',()=>{
 assert.equal(fixtureNetwork(undefined),null);
 fixtureDatabase('postgres://user:pass@127.0.0.1:25432/brai_bug_hunt_test','owner','brai_bug_hunt_test',null);
 fixtureServices('nats://127.0.0.1:24222','127.0.0.1:27233','bug-hunt-test-'+run,null);
 assert.throws(()=>fixtureDatabase(db,'owner','brai_bug_hunt_test',null));
 assert.throws(()=>fixtureNetwork('../other'));
});
