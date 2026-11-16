// ABOUTME: Проверяет sourceReader на настоящих Git objects во временном независимом репозитории.
// ABOUTME: Registry разрешает публичный Auth код, но не закрытые пути и symlink.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sourceReader} from '../dist/verification-sources.js';

test('immutable Auth source permits only registered safe blobs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bug-source-'));
 const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8'}).trim();
 try{
  git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  await mkdir(join(root,'services/auth/.hidden'),{recursive:true});
  for(const path of ['services/auth/ROLES.md','services/auth/auth.json','services/auth/.hidden/file','services/auth/runtime.json','services/auth/credentials.json'])await writeFile(join(root,path),'synthetic\n');
  await symlink('ROLES.md',join(root,'services/auth/link'));git('add','.');git('commit','-qm','fixture');
  const commit=git('rev-parse','HEAD');
  await writeFile(join(root,'services/auth/ROLES.md'),'changed\n');git('add','.');git('commit','-qm','second');const foreignCommit=git('rev-parse','HEAD');
  const snapshot={source:{id:'repo',component_id:'auth',commit}};
  const reader=sourceReader([{id:'repo',repository:root,components:['auth'],paths:['services/auth/'],commits:[commit],externalAllowed:true}]);
  assert.equal((await reader.read(snapshot,'repo','services/auth/ROLES.md')).text,'synthetic\n');
  for(const path of ['services/auth/auth.json','services/auth/.hidden/file','services/auth/runtime.json','services/auth/credentials.json','services/auth/../auth/ROLES.md','services/auth/link'])await assert.rejects(reader.read(snapshot,'repo',path),e=>e.code==='SOURCE_FORBIDDEN',path);
  await assert.rejects(reader.read(snapshot,'foreign','services/auth/ROLES.md'),e=>e.code==='SOURCE_UNAVAILABLE');
  await assert.rejects(reader.read({...snapshot,source:{...snapshot.source,commit:foreignCommit}},'repo','services/auth/ROLES.md'),e=>e.code==='SOURCE_UNAVAILABLE');
 }finally{await rm(root,{recursive:true,force:true});}
});
