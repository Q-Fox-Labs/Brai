// ABOUTME: Проверяет настоящий Codex app-server по изолированному Unix WebSocket.
// ABOUTME: Не подменяет model/tool loop; каждое утверждение сверяет persisted session и файлы.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {WebSocket} from 'ws';
const state=process.env.CODEWORKS_REAL_STATE,repo=process.env.CODEWORKS_REAL_REPOSITORY;
assert.ok(state?.startsWith('/')&&repo?.startsWith('/'),'explicit isolated state/repository required');
const ws=new WebSocket('ws+unix://'+state+'/codex-app.sock:/');
const pending=new Map(),events=[];let id=0;
ws.on('message',data=>{const f=JSON.parse(data);if(f.id!==undefined&&pending.has(f.id)){const p=pending.get(f.id);pending.delete(f.id);f.error?p.reject(new Error(JSON.stringify(f.error))):p.resolve(f.result);}else events.push(f);});
ws.on('close',()=>{for(const p of pending.values())p.reject(new Error('REAL_CODEX_CONNECTION_CLOSED'));pending.clear();});
await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
function call(method,params){const i=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(i);reject(new Error('REAL_CODEX_RPC_TIMEOUT '+method));},120000);pending.set(i,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id:i,method,params}));});}
async function until(predicate,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const found=events.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,50));}throw new Error('REAL_CODEX_TIMEOUT '+JSON.stringify(events.slice(-4)));}
async function session(thread){for(const name of await readdir(state))if(name.endsWith('.json')){const s=JSON.parse(await readFile(state+'/'+name));if(s.native_key==='codex:'+thread)return s;}throw new Error('NATIVE_IDENTITY_NOT_BOUND');}
async function turn(thread,prompt){events.length=0;const {turn}=await call('turn/start',{threadId:thread,input:[{type:'text',text:prompt}]});const result=await until(f=>f.method==='turn/completed'&&f.params.turn.id===turn.id);assert.equal(result.params.turn.status,'completed',JSON.stringify(result));return result;}
try {
 const init=await call('initialize',{clientInfo:{name:'codeworks_real_acceptance',version:'1.0.0'}});console.log('native server',init.userAgent);
 ws.send(JSON.stringify({method:'initialized'}));
 await assert.rejects(call('thread/resume',{threadId:'00000000-0000-0000-0000-000000000001',cwd:repo}),/LEGACY_THREAD_NOT_MANAGED/);
 const bypass=await call('command/exec',{cwd:repo,command:['/bin/sh','-c','printf bypass > CODEWORKS_NATIVE_BYPASS'],sandboxPolicy:{type:'dangerFullAccess'}});
 assert.notEqual(bypass.exitCode,0);await assert.rejects(readFile(repo+'/CODEWORKS_NATIVE_BYPASS'));
 console.log('PASS real native command/exec cannot bypass OS boundary even with dangerFullAccess');
 const {thread:docs}=await call('thread/start',{cwd:repo,model:'gpt-6.1-sol',approvalPolicy:'never'});
 const documentation='tmp/codeworks-agents-docs/readme-'+docs.id+'.md';
 await turn(docs.id,`Use codeworks batch write ${documentation} with exactly DOCS_REAL_OK followed by newline. Do not change any other file.`);
 assert.equal((await session(docs.id)).workspace_id,undefined);
 assert.equal(await readFile(repo+'/'+documentation,'utf8'),'DOCS_REAL_OK\n');
 console.log('PASS real Codex allowed documentation write creates no worktree');
 const {thread}=await call('thread/start',{cwd:repo,model:'gpt-6.1-sol',approvalPolicy:'never',ephemeral:false});
 console.log('thread',thread.id);
 await turn(thread.id,'Read package.json using codeworks action read and reply only with the package name. Do not write anything.');
 assert.equal((await session(thread.id)).workspace_id,undefined);console.log('PASS real Codex read creates no worktree');
 await turn(thread.id,`Use codeworks to create tmp/codeworks-agents-real/codex.txt containing exactly CODEX_REAL_OK followed by newline. Then read that file using its absolute base path ${repo}/tmp/codeworks-agents-real/codex.txt and confirm the content. Do not run native tools.`);
 const s=await session(thread.id);assert.ok(s.workspace_id);const root=state+'/workspaces/'+s.workspace_id;
 assert.equal(await readFile(root+'/tmp/codeworks-agents-real/codex.txt','utf8'),'CODEX_REAL_OK\n');
 await assert.rejects(readFile(repo+'/tmp/codeworks-agents-real/codex.txt'));console.log('PASS real Codex first write automatically prepares WT and keeps base unchanged',s.id,s.workspace_id);
 await call('thread/resume',{threadId:thread.id,cwd:repo});
 await turn(thread.id,'Using codeworks read tmp/codeworks-agents-real/codex.txt and reply only with its content. Do not write.');
 assert.equal((await session(thread.id)).workspace_id,s.workspace_id);console.log('PASS real Codex managed resume keeps routing',thread.id);
 await turn(thread.id,'Use codeworks patch to add tmp/codeworks-agents-real/patch.txt with line A, then patch Update File and Move to tmp/codeworks-agents-real/moved.txt changing A to B. Use batch to create symlink tmp/codeworks-agents-real/link.txt targeting moved.txt, read link, then delete link. Use explicit mode write command with argv ["/bin/sh","-c","printf COMMAND_OK > tmp/codeworks-agents-real/command.txt"]. Verify the two final files.');
 assert.equal(await readFile(root+'/tmp/codeworks-agents-real/moved.txt','utf8'),'B\n');
 assert.equal(await readFile(root+'/tmp/codeworks-agents-real/command.txt','utf8'),'COMMAND_OK');
 await assert.rejects(readFile(root+'/tmp/codeworks-agents-real/link.txt'));
 console.log('PASS real Codex patch/move/symlink/delete/write command');
 await turn(thread.id,'Spawn one native subagent to read package.json using codeworks and report the package name. The subagent must use its own codeworks tool. Wait for its result and report it. Do not write.');
 const identities=[];for(const name of await readdir(state))if(name.endsWith('.json'))identities.push(JSON.parse(await readFile(state+'/'+name)));
 const history=await call('thread/read',{threadId:thread.id,includeTurns:true});
 const childIds=history.thread.turns.at(-1).items.flatMap(item=>item.type==='subAgentActivity'?[item.agentThreadId]:item.receiverThreadIds??[]);
 assert.ok(childIds.length,'native subagent thread was not observed');
 const child=identities.find(candidate=>childIds.some(childId=>candidate.native_key==='codex:'+childId));
 assert.ok(child,'native child did not receive its own managed tool identity');assert.notEqual(child.id,s.id);
 assert.equal(child.workspace_id,undefined);console.log('PASS real native parent/subagent identities differ',s.id,child.id);
 console.log(JSON.stringify({thread_id:thread.id,session_id:s.id,workspace_id:s.workspace_id}));
} finally {ws.close();setTimeout(()=>ws.terminate(),500).unref();}
