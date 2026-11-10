// ABOUTME: Проверяет квитанцию после реального pg_dump/pg_restore в отдельную fixture БД.
// ABOUTME: Принимает только loopback restore-БД; не изменяет первичный источник.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {fixture} from './fixture.mjs';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {createHandlers} from '../../dist/domain.js';
test('restored database preserves original receipt and observation',async()=>{
 const ownerURL=new URL(fixture.ownerURL),appURL=new URL(fixture.appURL);
 ownerURL.pathname=appURL.pathname='/brai_bug_hunt_restore';
 assert.equal(ownerURL.hostname,'127.0.0.1');assert.equal(appURL.hostname,'127.0.0.1');
 const owner=new Pool({connectionString:ownerURL.href,max:1}),app=new Pool({connectionString:appURL.href,max:1});
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  const found=await owner.query("SELECT m.*,r.observation FROM mutation m JOIN report r ON r.id=(m.result->>'report_id')::uuid WHERE m.operation='report' AND m.installation_id='fixture-installation' ORDER BY r.registered_at LIMIT 1");
  assert.equal(found.rowCount,1);const row=found.rows[0];
  const core=createHandlers({store:createStore(app,{installationId:row.installation_id,cursorKey:'fixture-cursor-key-at-least-32-bytes',maxReports:1,reportsPerMinute:1,maxDatabaseBytes:1}),evidence:async()=>{throw Error('Replay must not revalidate evidence');}});
  const p={ownerId:row.owner_id,actorId:row.actor_id,source:'codex',reviewer:false};
  assert.deepEqual(await core.invoke('report',p,{request_id:row.request_id,observation:row.observation}),{...row.result,replayed:true});
  assert.deepEqual((await core.invoke('get',p,{case_id:row.result.case_id})).report.observation,row.observation);
 }finally{await Promise.all([owner.end(),app.end()]);}
});
