// ABOUTME: Проверяет переходы допуска вызова записи и активацию области.
// ABOUTME: Подменяет SQL и Git; интеграционные транзакции проверяются отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWriteAdmission} from '../src/write-admission.mjs';
const w={id:'w',base_sha:'base',preparation_state:'ready'};
const call={id:'c',workspace_id:'w',state:'in_flight',tool_result:null};
function fixture(changed){const queries=[];let row={...call};const query=async(sql,args=[])=>{queries.push({sql,args});if(sql.startsWith('SELECT * FROM codeworks.write_calls'))return {rows:[row],rowCount:1};if(sql.startsWith('SELECT * FROM codeworks.workspaces'))return {rows:[w],rowCount:1};if(sql.startsWith('UPDATE codeworks.write_calls SET state=\'finished\'')){row={...row,state:'finished',tool_result:JSON.parse(args[1])};return {rows:[],rowCount:1};}if(sql.includes('UPDATE codeworks.write_calls SET state=CASE'))return {rows:[{state:'uncertain'}],rowCount:1};return {rows:[],rowCount:0};};const pool={query,connect:async()=>({query,release(){}})};const api=createWriteAdmission(pool,{prepare:async()=>{},workspace:async()=>({project:{},workspace:w}),inspect:async()=>({dirty:changed,head:'base'})});return {api,queries};}
test('finished write activates only after an observed tree change, including error',async()=>{for(const changed of [false,true]){const f=fixture(changed);const result=await f.api.finish({project_id:'p',session_id:'s',turn_id:'t',tool_use_id:'u',outcome:'error'},'e');assert.equal(result.changed,changed);assert.equal(f.queries.some(q=>q.sql.includes("activation_state='active'")),changed);}});
test('stop leaves in-flight write uncertain',async()=>{const f=fixture(false);assert.deepEqual(await f.api.stop({project_id:'p',session_id:'s',turn_id:'t',event:'Stop'},'e'),{closed:0,uncertain:1});assert.match(f.queries.find(q=>q.sql.includes('UPDATE codeworks.write_calls SET state=CASE')).sql,/uncertain/);});

test('stop stores only safe event and reason for never-admitted calls',async()=>{
 const f=fixture(false);await f.api.stop({project_id:'p',session_id:'s',turn_id:'t',event:'Stop',reason:'prepare_pending'},'e');
 const query=f.queries.find(q=>q.sql.includes('UPDATE codeworks.write_calls SET state=CASE'));
 assert.match(query.sql,/state IN \('preparing','denied_pending'\).*stop_event/);assert.match(query.sql,/prepare_pending.*THEN NULL/);assert.deepEqual(query.args.slice(-2),['Stop','prepare_pending']);
});
test('stopped call never starts a new preparation',async()=>{
 let called=false;const existing={id:'c',workspace_id:null,state:'denied_pending',tool_name:'apply_patch',payload_sha256:'a',targets:['src/a'],workspace_key:'task',kind:'feature',request_key:'r'};
 const query=async sql=>sql.startsWith('SELECT * FROM codeworks.write_calls')?{rows:[existing],rowCount:1}:{rows:[],rowCount:0};
 const api=createWriteAdmission({connect:async()=>({query,release(){}})},{prepare:async()=>{called=true;},workspace:async()=>{},inspect:async()=>{}});
 await assert.rejects(api.begin({project_id:'p',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',payload_sha256:'a',targets:['src/a'],workspace_key:'task',request_key:'r'},'e'),{code:'CONFLICT'});assert.equal(called,false);
});

test('replay for removed workspace never returns its former path',async()=>{
 const existing={id:'c',workspace_id:'w',state:'finished',tool_name:'apply_patch',payload_sha256:'a',targets:['src/a'],workspace_key:'task',kind:'feature',request_key:'r'};
 const query=async sql=>sql.startsWith('SELECT * FROM codeworks.write_calls')?{rows:[existing],rowCount:1}:{rows:[],rowCount:0};
 const api=createWriteAdmission({connect:async()=>({query,release(){}})},{prepare:async()=>assert.fail('must not recreate'),workspace:async()=>({workspace:{removed_at:'now'}}),inspect:async()=>{}});
 await assert.rejects(api.begin({project_id:'p',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',payload_sha256:'a',targets:['src/a'],workspace_key:'task',request_key:'r'},'e'),{code:'CONFLICT'});
});

test('one session reuses one key for multiple targets and gets a new key after removal',async()=>{
 const rows=[],workspaces=new Map();let sequence=0;
 const query=async(sql,args=[])=>{
  if(sql.startsWith('INSERT INTO codeworks.write_calls')) {rows.push({id:args[0],project_id:args[1],executor_id:args[2],session_id:args[3],turn_id:args[4],tool_use_id:args[5],tool_name:args[6],payload_sha256:args[7],targets:JSON.parse(args[8]),workspace_key:args[9],kind:args[10],request_key:args[11],state:'preparing',workspace_id:null});return {rowCount:1,rows:[]};}
  if(sql.startsWith('SELECT * FROM codeworks.write_calls WHERE project_id='))return {rows:rows.filter(x=>x.project_id===args[0]&&x.executor_id===args[1]&&x.session_id===args[2]&&x.turn_id===args[3]&&x.tool_use_id===args[4]),rowCount:1};
  if(sql.includes('SELECT c.workspace_key,c.kind'))return {rows:rows.filter(x=>x.session_id===args[2]&&(!x.workspace_id||!workspaces.get(x.workspace_id)?.removed_at)).map(x=>({workspace_key:x.workspace_key,kind:x.kind,workspace_id:x.workspace_id,lifecycle:'active',workflow_state:'open'}))};
  if(sql.startsWith('UPDATE codeworks.write_calls SET workspace_id=')) {const row=rows.find(x=>x.id===args[0]);row.workspace_id=args[1];row.operation_id=args[2];return {rows:[row],rowCount:1};}
  return {rows:[],rowCount:0};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const api=createWriteAdmission(pool,{prepare:async args=>{let w=[...workspaces.values()].find(x=>x.workspace_key===args.workspace_key&&!x.removed_at);if(!w){const id='w'+(++sequence);w={id,workspace_key:args.workspace_key,kind:args.kind,path:'/tree/'+id,branch:'feature/'+args.workspace_key};workspaces.set(id,w);}return {workspace_id:w.id,operation_id:'o'+w.id,path:w.path,branch:w.branch};},workspace:async(_,id)=>({workspace:workspaces.get(id)}),inspect:async()=>({})});
 const input=(tool,targets)=>({project_id:'p',session_id:'s',turn_id:'t',tool_use_id:tool,tool_name:'apply_patch',payload_sha256:tool,targets,request_key:tool});
 const first=await api.begin(input('one',['services/auth/index.mjs']),'e');
 const second=await api.begin(input('two',['apps/web/form.ts']),'e');
 assert.equal(first.workspace_key,second.workspace_key);assert.equal(first.workspace_id,second.workspace_id);
 assert.equal((await api.begin(input('one',['services/auth/index.mjs']),'e')).workspace_key,first.workspace_key);
 workspaces.get(first.workspace_id).removed_at='now';
 const third=await api.begin(input('three',['services/auth/index.mjs']),'e');
 assert.notEqual(third.workspace_key,first.workspace_key);assert.notEqual(third.workspace_id,first.workspace_id);
});
