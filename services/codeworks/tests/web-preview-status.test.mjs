// ABOUTME: Проверяет безопасную конфигурацию и публичные состояния веб-превью.
// ABOUTME: Статус не раскрывает CI proof и не меняет срок аренды.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from '../src/contracts.mjs';
import {publicWebPreview} from '../src/web-preview-status.mjs';
import {createHandlers} from '../src/domain.mjs';

const id='0997203d-1266-4cf7-9668-d985b3eec801',sha='a'.repeat(40);
const policy={enabled:true,ttl_seconds:172800,slots:[{id:'01',url:'https://preview-01.example.test'},{id:'02',url:'https://preview-02.example.test'}]};
const project={id:'p',repo_path:'/repo',common_dir:'/repo/.git',workspace_root:'/areas',allowed_paths:['.'],excluded_paths:['.git'],executors:['codex'],git_flow:{feature_base:'refs/remotes/origin/dev',hotfix_base:'refs/remotes/origin/main',feature_prefix:'feature/',hotfix_prefix:'hotfix/'},preparer_path:'/repo/.git/hooks/prepare',node_version:'24.22.1',platform:'linux-x64',github:{repository:'fixture/repo',required_checks:[{name:'Codeworks components',app_id:1}],ci:{check_name:'Codeworks components',app_id:1,workflow_sha256:'a'.repeat(64),recipe_sha256:'b'.repeat(64)}},web_preview:policy};

test('preview project requires two distinct HTTPS origins and a trusted CI policy',()=>{
  validate('project.register',{project});
  for(const slots of [policy.slots.slice(0,1),[policy.slots[0],policy.slots[0]],policy.slots.map(s=>({...s,url:policy.slots[0].url}))]){
    assert.throws(()=>validate('project',{...project,web_preview:{...policy,slots}}),{code:'INVALID_ARGUMENT'});
  }
  for(const url of ['http://example.test','https://user:pass@example.test','https://example.test/path','https://example.test?token=secret','https://example.test#fragment','https://*.example.test']){
    assert.throws(()=>validate('project',{...project,web_preview:{...policy,slots:[{id:'01',url},policy.slots[1]]}}),{code:'INVALID_ARGUMENT'},url);
  }
  assert.throws(()=>validate('project',{...project,github:undefined}),{code:'INVALID_ARGUMENT'});
  validate('project',{...project,web_preview:{enabled:false},github:undefined});
});

test('public preview separates pending desired SHA from previous deployed version and masks private errors',()=>{
  const row={state:'failed',desired_sha:sha,pending_sha:'b'.repeat(40),deployed_sha:'c'.repeat(40),slot_id:'01',backend_changed:true,ci_proof:{token:'private'},error:'private database password',published_at:'2026-10-29T12:00:00.000Z',expires_at:'2026-10-31T12:00:00.000Z'};
  const before=structuredClone(row),status=publicWebPreview(row,policy);
  assert.equal(status.desired_sha,'b'.repeat(40));assert.equal(status.deployed_sha,'c'.repeat(40));assert.equal(status.error,'PREVIEW_UNAVAILABLE');
  assert.equal(status.url,policy.slots[0].url);assert.equal(status.shared_backend,true);assert.equal(status.backend_changed,true);
  assert.equal('ci_proof' in status,false);assert.equal(JSON.stringify(status).includes('private'),false);
  assert.deepEqual(row,before);validate('statusResponse',{preview:status});
  assert.equal(publicWebPreview(null,policy),null);
});

test('FIFO position is numeric and appears only while queued',()=>{
  const queued=publicWebPreview({state:'queued',desired_sha:sha,queue_position:'3'},policy);
  assert.equal(queued.queue_position,3);assert.equal(queued.url,null);validate('statusResponse',{preview:queued});
  assert.equal(publicWebPreview({state:'expired',desired_sha:sha,queue_position:'3'},policy).queue_position,null);
});

test('status exposes preview only for enabled projects without changing its persisted expiry',async()=>{
  const workspace={id,project_id:'p',workspace_key:'example',element_id:null,kind:'feature',base_ref:'refs/remotes/origin/dev',base_sha:sha,branch:'feature/example',path:'/areas/'+id,preparation_state:'intent',created_at:'2026-10-29T12:00:00.000Z'};
  const row={state:'ready',desired_sha:sha,deployed_sha:sha,slot_id:'01',expires_at:'2026-10-31T12:00:00.000Z'};
  let config=structuredClone(project),reads=0;
  const db={project:async()=>config,workspace:async()=>workspace,latestOperation:async()=>null,webPreview:async()=>{reads++;return row;}};
  const handlers=createHandlers({read:async(_,work)=>work(db)},{},{allowedRepositories:['/repo']});
  const args={project_id:'p',workspace_id:id};
  const first=await handlers.call('status',args,'codex');
  assert.equal(first.preview.expires_at,row.expires_at);assert.equal(first.preview.deployed_sha,sha);
  assert.deepEqual(await handlers.call('status',args,'codex'),first);assert.equal(reads,2);
  config={...config,web_preview:{enabled:false}};
  assert.equal('preview' in await handlers.call('status',args,'codex'),false);assert.equal(reads,2);
});
