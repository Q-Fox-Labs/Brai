// ABOUTME: Проверяет durable очередь двух превью в настоящей тестовой PostgreSQL.
// ABOUTME: Git, CI и операторский adapter заменены управляемыми портами; пользовательская БД не используется.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {configured,setup} from './fixture.mjs';
import {reconcilePreviewProject} from '../../src/preview.mjs';

const base='0'.repeat(40),sha=n=>String(n).repeat(40),digest='sha256:'+'a'.repeat(64),image='ghcr.io/test/web@'+digest;
test('две аренды, FIFO, новый HEAD и подтверждённое удаление', {skip:!configured}, async()=>{
 const f=await setup();
 try {
  const projectId='preview-test',project={id:projectId,repo_path:'/tmp/preview-fixture',common_dir:'/tmp/preview-common',workspace_root:'/tmp/preview-root',web_preview:{enabled:true,ttl_seconds:172800,slots:[{id:'01',url:'https://preview-01.example'},{id:'02',url:'https://preview-02.example'}]}};
  await f.owner.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[projectId,project]);
  const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005'];
  for(let i=0;i<ids.length;i++){
   await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,preparation_state) VALUES($1,$2,$3,'feature','dev',$4,$5,$6,$7,'ready')",[ids[i],projectId,'task-'+i,base,'feature/task-'+i,'/tmp/preview-'+i,randomUUID()]);
   await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",['wf-'+i,projectId,ids[i]]);
  }
  const heads=new Map(ids.map((id,i)=>[id,sha(i===4?8:i+1)]));let shouldFail=false,loseOnce=false;
  const ports={remote:async(_p,w)=>heads.get(w.id),closed:async()=>false,classify:async()=>({web:true,backend:false}),
   verify:async(_p,s)=>s===sha(4)?{verified:false}:({verified:true,evidence:{head_sha:s,run_id:'1',attempt:'1',policy_sha256:'b'.repeat(64),composition_digest:digest},image_reference:image}),
   adapter:async(method,id,generation)=>{const row=(await f.app.query('SELECT * FROM codeworks.web_previews WHERE id=$1',[id])).rows[0];
    if(method==='publish'&&(row.pending_cancel||(row.pending_sha&&row.pending_sha!==row.desired_sha)))return {status:'failed',error_code:'PREVIEW_SUPERSEDED',preview_id:id,generation,deployed_sha:row.deployed_sha,image_reference:row.deployed_image_reference};
    if(method==='publish'&&loseOnce){loseOnce=false;return {status:'unknown',preview_id:id,generation};}
    if(method==='publish')return {status:shouldFail?'failed':'ready',preview_id:id,generation,deployed_sha:shouldFail?row.deployed_sha:row.desired_sha,image_reference:shouldFail?row.deployed_image_reference:row.image_reference};
    if(method==='remove')return {status:'absent',preview_id:id,generation,deployed_sha:null,image_reference:null};
    return {status:row.action==='publish'&&row.deployed_sha!==row.desired_sha?'pending':row.deployed_sha?'ready':'absent',preview_id:id,generation,deployed_sha:row.deployed_sha,image_reference:row.deployed_image_reference};}};
  const pass=()=>reconcilePreviewProject(f.app,projectId,ports);
  await pass();await pass();await pass();
  let rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.deepEqual(rows.map(r=>r.state),['ready','ready','queued','waiting_ci','queued']);assert.deepEqual(rows.map(r=>r.slot_id),['01','02',null,null,null]);
  const old=rows[0].deployed_sha;heads.set(ids[0],sha(5));shouldFail=true;await pass();
  rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[0].state,'failed');assert.equal(rows[0].deployed_sha,old);assert.equal(rows[0].desired_sha,sha(5));
  shouldFail=false;await f.owner.query("UPDATE codeworks.workflow_registry SET lifecycle='cancelled',state='completed' WHERE workspace_id=ANY($1::uuid[])",[[ids[1],ids[4]]]);
  await pass();await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[1].slot_id,null);assert.equal(rows[2].state,'ready');assert.equal(rows[2].slot_id,'02');assert.equal(rows[4].state,'expired');assert.equal(rows[4].slot_id,null);
  await f.owner.query("UPDATE codeworks.web_previews SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",[ids[2]]);
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].state,'expired');assert.equal(rows[2].slot_id,null);
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].state,'expired');
  const op=randomUUID();await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'fixture','sync','succeeded','done',$4)",[op,projectId,ids[2],{commit_sha:sha(3)}]);
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].state,'ready');assert.equal(rows[2].last_sync_operation_id,op);
  heads.set(ids[2],sha(6));loseOnce=true;await pass();
  rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].state,'publishing');assert.equal(rows[2].desired_sha,sha(6));
  heads.set(ids[2],sha(7));await pass();
  rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].desired_sha,sha(7));assert.equal(rows[2].deployed_sha,sha(3));assert.equal(rows[2].state,'waiting_ci');
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].desired_sha,sha(7));assert.equal(rows[2].deployed_sha,sha(7));
  // Неизвестный publish после отмены только откатывается и затем очищает старый ресурс.
  heads.set(ids[2],sha(8));loseOnce=true;await pass();
  await f.owner.query("UPDATE codeworks.workflow_registry SET lifecycle='cancelled',state='completed' WHERE workspace_id=$1",[ids[2]]);
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].action,'remove');assert.equal(rows[2].deployed_sha,sha(7));
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.equal(rows[2].state,'expired');assert.equal(rows[2].slot_id,null);
  // PR закрывается между его первым чтением и непосредственным допуском публикации.
  await f.owner.query("UPDATE codeworks.web_previews SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",[ids[2]]);await pass();
  const sixth='00000000-0000-4000-8000-000000000006';
  await f.owner.query("INSERT INTO codeworks.workspaces(id,project_id,workspace_key,kind,base_ref,base_sha,branch,path,ownership_token,preparation_state) VALUES($1,$2,'task-six','feature','dev',$3,'feature/task-six','/tmp/preview-six',$4,'ready')",[sixth,projectId,base,randomUUID()]);
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES('wf-six',$1,$2,'temporal')",[projectId,sixth]);heads.set(sixth,sha(9));
  let checks=0;ports.closed=async(_p,w)=>w.id===sixth&&++checks>=2;await pass();
  const closed=(await f.app.query('SELECT * FROM codeworks.web_previews WHERE workspace_id=$1',[sixth])).rows[0];
  assert.equal(closed.state,'expired');assert.equal(closed.slot_id,null);assert.equal(closed.deployed_sha,null);
  rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  const prior=rows.map(r=>r.updated_at.toISOString());
  await f.owner.query("UPDATE codeworks.projects SET config=jsonb_set(config,'{web_preview,enabled}','false'::jsonb) WHERE id=$1",[projectId]);
  await pass();rows=(await f.app.query('SELECT * FROM codeworks.web_previews ORDER BY workspace_id')).rows;
  assert.deepEqual(rows.map(r=>r.updated_at.toISOString()),prior);
 } finally {await f.close();}
});
