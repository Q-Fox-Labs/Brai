// ABOUTME: Проверяет реальные PostgreSQL/Git/bubblewrap границы доверенного agent executor.
// ABOUTME: Эти проверки не заменяют приёмку настоящих Codex/Hermes entrypoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,mkdtemp,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {setup,configured} from './fixture.mjs';
import {createAgentHost,socketCall} from '../../src/agent-host.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {createGit,command} from '../../src/git.mjs';

test('real agent executor: lazy workspace, whole batch, kernel RO and dirty handoff',{skip:!configured,timeout:180000},async()=>{
  const f=await setup();let host,state;
  try {
    const project=await f.project({documentationPaths:['docs'],sharedFixture:true});
    const common=(await command('git',['rev-parse','--path-format=absolute','--git-common-dir'])).stdout;
    state=await mkdtemp(path.join(path.dirname(common),'tmp/cwa-'));
    const handlers=createHandlers(createStore(f.app),createGit(),{allowedRepositories:[project.repo_path],assertQuiescent:r=>host.quiesce(r)});
    const workers=[];
    host=await createAgentHost({state_root:state,hidden_paths:[project.workspace_root],projects:[project.id],adapter_project_id:project.id,executors:{codex:{},hermes:{}},require_immutable:false},async(method,args,executor)=>{
      const result=await handlers.call(method,args,executor);
      if(method==='prepare-write')workers.push(f.worker(project,result.operation_id));
      return result;
    });
    const control=request=>socketCall(path.join(state,'control.sock'),request);
    await assert.rejects(socketCall(path.join(state,'codex.adapter.sock'),{payload:'{}',signature:'00'}),/ADAPTER_DENIED/);
    const codex=await control({action:'open',project_id:project.id,executor_id:'codex'});
    const call=request=>socketCall(codex.socket,request);
    assert.equal((await call({action:'read',path:'hello.txt'})).content,'frozen base\n');
    assert.equal((await call({action:'status'})).workspace,null);
    await writeFile(path.join(project.repo_path,'.env'),'SYNTHETIC_PRIVATE_FIXTURE');
    const privateRead=await call({action:'command',mode:'read',argv:['/bin/cat','.env']});
    assert.equal(privateRead.stdout,'');
    const nested=await call({action:'command',mode:'read',argv:['/usr/bin/unshare','--user','--map-root-user','/bin/true']});
    assert.notEqual(nested.exit_code,0);
    await call({action:'batch',operations:[{op:'write',path:'docs/readme.md',content:'documented\n'}]});
    assert.equal((await call({action:'status'})).workspace,null);
    assert.equal(await readFile(path.join(project.repo_path,'docs/readme.md'),'utf8'),'documented\n');
    await assert.rejects(call({action:'batch',operations:[{op:'write',path:'docs/partial.md',content:'must not appear'},{op:'rename',path:'docs/readme.md'}]}),/FILE_OPERATION_REJECTED/);
    await assert.rejects(readFile(path.join(project.repo_path,'docs/partial.md')));
    assert.equal((await call({action:'status'})).workspace,null);
    const readonly=await call({action:'command',mode:'read',argv:['/bin/sh','-c','printf forbidden > hello.txt']});
    assert.equal(readonly.exit_code,2);
    assert.equal((await call({action:'status'})).workspace,null);
    await assert.rejects(call({action:'batch',operations:[{op:'write',path:'docs/readme.md',content:'partial'},{op:'write',path:'/tmp/escape.js',content:'escape'}]}),/PATH_DENIED/);
    assert.equal(await readFile(path.join(project.repo_path,'docs/readme.md'),'utf8'),'documented\n');
    await call({action:'batch',operations:[{op:'write',path:'docs/readme.md',content:'workspace docs\n'},{op:'write',path:path.join(project.repo_path,'new.js'),content:'export default 1;\n'}]});
    const status=await call({action:'status'}),area=status.workspace.path;
    assert.notEqual(area,project.repo_path);
    assert.equal(await readFile(path.join(project.repo_path,'docs/readme.md'),'utf8'),'documented\n');
    assert.equal((await call({action:'read',path:path.join(project.repo_path,'docs/readme.md')})).content,'workspace docs\n');
    const resumed=await control({action:'open',resume:codex.session_id});assert.equal(resumed.session_id,codex.session_id);
    await call({action:'patch',patch:'*** Begin Patch\n*** Update File: new.js\n*** Move to: moved.js\n@@\n-export default 1;\n+export default 2;\n*** End Patch'});
    assert.equal((await call({action:'read',path:'moved.js'})).content,'export default 2;\n');
    await call({action:'batch',operations:[{op:'symlink',path:'local-alias.js',target:'moved.js'}]});
    await call({action:'batch',operations:[{op:'write',path:'local-alias.js',content:'through alias\n'}]});
    assert.equal((await call({action:'read',path:'moved.js'})).content,'through alias\n');
    await call({action:'batch',operations:[{op:'delete',path:'local-alias.js'}]});
    await assert.rejects(call({action:'batch',operations:[{op:'symlink',path:'escape',target:'../../outside'}]}),/PATH_DENIED/);
    const neighbor=path.join(path.dirname(area),'neighbor');await mkdir(neighbor);await writeFile(path.join(neighbor,'keep'),'unchanged');
    const bypass=await call({action:'command',mode:'write',argv:['/bin/sh','-c',`set -e; printf blocked > '${neighbor}/keep'`]});
    assert.notEqual(bypass.exit_code,0);assert.equal(await readFile(path.join(neighbor,'keep'),'utf8'),'unchanged');
    const dependencyRead=await call({action:'command',mode:'read',argv:['/bin/cat','node_modules/shared-readonly/keep.js']});
    assert.equal(dependencyRead.exit_code,0);assert.equal(dependencyRead.stdout,'shared dependency\n');
    const dependency=await call({action:'command',mode:'write',argv:['/bin/sh','-c','printf forbidden > node_modules/shared-readonly/keep.js']});
    assert.notEqual(dependency.exit_code,0);
    assert.equal(await readFile(path.join(project.repo_path,'node_modules/shared-readonly/keep.js'),'utf8'),'shared dependency\n');
    assert.ok((await lstat(path.join(area,'node_modules/shared-readonly'))).isSymbolicLink());
    const local=await call({action:'command',mode:'write',argv:['/bin/sh','-c','printf local > node_modules/@fixture/leaf/local.js']});
    assert.equal(local.exit_code,0);assert.equal(await readFile(path.join(area,'packages/leaf/local.js'),'utf8'),'local');
    await assert.rejects(readFile(path.join(project.repo_path,'packages/leaf/local.js')));
    // Открытый shell остаётся жив до передачи; после неё все его descendants остановлены.
    const terminal=await call({action:'command',mode:'write',argv:['/bin/sh']});
    await call({action:'stdin',command_id:terminal.command_id,input:'printf before > dirty.txt\n'});
    assert.equal(await readFile(path.join(area,'dirty.txt'),'utf8'),'before');
    const hermes=await control({action:'open',project_id:project.id,executor_id:'hermes'});
    await control({action:'quiesce',session_id:codex.session_id});
    await control({action:'attach',session_id:hermes.session_id,workspace_id:status.workspace.id});
    await assert.rejects(call({action:'stdin',command_id:terminal.command_id,input:'printf after > dirty.txt\n'}),/WRITER_FENCED/);
    assert.equal(await readFile(path.join(area,'dirty.txt'),'utf8'),'before');
    await socketCall(hermes.socket,{action:'batch',operations:[{op:'write',path:'hermes.js',content:'new writer\n'}]});
    assert.equal(await readFile(path.join(area,'dirty.txt'),'utf8'),'before');
    assert.equal((await socketCall(hermes.socket,{action:'status'})).workspace.writer.epoch,2);
    await Promise.all(workers);
  } finally {await host?.close();if(state)await rm(state,{recursive:true,force:true});await f.close();}
});
