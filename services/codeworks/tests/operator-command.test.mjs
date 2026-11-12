// ABOUTME: Проверяет границу root-оператора и очищенную спецификацию Git/gh без смены системного UID.
// ABOUTME: Реальный runuser проверяется отдельным root-only fixture; моки UID не дают полномочий процессу.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {withExecutionContext} from '../src/execution-context.mjs';
import {withOperatorCommands,operatorCommandSpec,runOperatorDispatch,probeOperatorArchiveAccess} from '../src/operator-command.mjs';

// AIDEV-NOTE: Hosted CI has no deployment account; use a real local non-root account only for specs.
const operatorUser=readFileSync('/etc/passwd','utf8').split('\n').map(row=>row.split(':')).find(row=>/^[a-z_][a-z0-9_-]{0,31}$/.test(row[0])&&Number.isSafeInteger(Number(row[2]))&&Number(row[2])>0&&Number.isSafeInteger(Number(row[3]))&&Number(row[3])>=0)?.[0];
assert.ok(operatorUser,'non-root local fixture account is required');

test('обычный сервис не включает operator policy из переменной окружения',t=>{
  const old=process.env.CODEWORKS_OPERATOR_USER;process.env.CODEWORKS_OPERATOR_USER=operatorUser;
  t.after(()=>{if(old===undefined)delete process.env.CODEWORKS_OPERATOR_USER;else process.env.CODEWORKS_OPERATOR_USER=old;});
  assert.equal(operatorCommandSpec('git',['status']),null);
  assert.equal(operatorCommandSpec('gh',['auth','status']),null);
});

test('root permission проверяется по реальному API, а не по USER или env',t=>{
  t.mock.method(process,'geteuid',()=>1000);
  assert.throws(()=>withOperatorCommands(operatorUser,()=>operatorCommandSpec('git',['status'])),/OWNER_REQUIRED/);
});

test('root operator требует non-root local user и не принимает shell/path tokens',t=>{
  t.mock.method(process,'geteuid',()=>0);
  for(const user of ['root','-agent','agent;id','agent\n','/home/agent','a'.repeat(33),'codeworks_missing_operator']){
    assert.throws(()=>withOperatorCommands(user,()=>{}),/OPERATOR_USER_INVALID/);
  }
  withOperatorCommands(undefined,()=>{
    assert.throws(()=>operatorCommandSpec('git',['status']),/OPERATOR_USER_REQUIRED/);
    assert.throws(()=>operatorCommandSpec('/usr/bin/gh',['auth','status']),/OPERATOR_USER_REQUIRED/);
    assert.equal(operatorCommandSpec(process.execPath,['root-adapter.mjs']),null);
  });
});

test('Git и gh получают fixed argv и allowlist env без root профиля, токенов или DB',t=>{
  t.mock.method(process,'geteuid',()=>0);
  const args=['-C','/fixture/repo','status','literal;$(id)'];
  withOperatorCommands(operatorUser,()=>{
    for(const [name,absolute] of [['git','/usr/bin/git'],['/usr/bin/gh','/usr/bin/gh']]){
      const spec=operatorCommandSpec(name,args);
      assert.equal(spec.executable,'/usr/sbin/runuser');
      assert.equal(spec.cwd,'/');
      assert.deepEqual(spec.args,['--user',operatorUser,'--',absolute,...args]);
      assert.deepEqual(spec.env,{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'});
      for(const key of ['HOME','GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR','CODEWORKS_DATABASE_URL','PGPASSWORD','GIT_CONFIG_GLOBAL','NODE_OPTIONS'])assert.equal(Object.hasOwn(spec.env,key),false);
    }
    assert.equal(operatorCommandSpec('/usr/local/libexec/root-adapter',[]),null);
  });
  assert.deepEqual(args,['-C','/fixture/repo','status','literal;$(id)']);
});

test('ALS не переносит root operator policy в другой параллельный проход',async t=>{
  t.mock.method(process,'geteuid',()=>0);
  await Promise.all([
    withOperatorCommands(operatorUser,async()=>{await Promise.resolve();assert.equal(operatorCommandSpec('git',['status']).args[1],operatorUser);}),
    withOperatorCommands(undefined,async()=>{await Promise.resolve();assert.throws(()=>operatorCommandSpec('git',['status']),/OPERATOR_USER_REQUIRED/);}),
  ]);
  assert.equal(operatorCommandSpec('git',['status']),null);
});


test('non-root legacy cleanup dispatch сохраняется, остальные private команды требуют root',t=>{
  t.mock.method(process,'geteuid',()=>1000);
  const old=process.env.CODEWORKS_OPERATOR_USER;process.env.CODEWORKS_OPERATOR_USER='root';
  t.after(()=>{if(old===undefined)delete process.env.CODEWORKS_OPERATOR_USER;else process.env.CODEWORKS_OPERATOR_USER=old;});
  for(const method of ['cleanup-import','cleanup-preflight','write-completion-import'])assert.equal(runOperatorDispatch(method,()=>operatorCommandSpec('git',['status'])),null);
  for(const method of ['cleanup-resume','workflow-repair','postprocess-repair','write-completion-attest'])assert.throws(()=>runOperatorDispatch(method,()=>assert.fail('private dispatch ran')),/OWNER_REQUIRED/);
});

test('typed archive probe подтверждает static child UID/nonce и только подлинные access errno',async t=>{
  t.mock.method(process,'geteuid',()=>0);
  const file='/fixture/private.bundle',typed=(spec,fields={})=>JSON.stringify({version:1,nonce:spec.nonce,uid:spec.uid,status:'readable',errno:null,...fields});
  await withOperatorCommands(operatorUser,()=>probeOperatorArchiveAccess(file,{runProbe:async spec=>{
    assert.equal(spec.executable,'/usr/sbin/runuser');assert.deepEqual(spec.args.slice(0,4),['--user',operatorUser,'--',process.execPath]);
    assert.deepEqual(spec.args.slice(-2),[file,spec.nonce]);assert.match(spec.args[6],/fs.openSync/);assert.match(spec.args[6],/O_NOFOLLOW/);assert.equal(spec.args[6].includes(file),false);
    assert.equal(spec.cwd,'/');assert.deepEqual(Object.keys(spec.env).sort(),['GH_PROMPT_DISABLED','GIT_TERMINAL_PROMPT','LANG','LC_ALL','PATH']);
    return {code:0,stdout:typed(spec)};
  }}));
  for(const errno of ['EACCES','EPERM'])await assert.rejects(withOperatorCommands(operatorUser,()=>probeOperatorArchiveAccess(file,{runProbe:async spec=>({code:0,stdout:typed(spec,{status:'error',errno})})})),{code:'ARCHIVE_ACCESS_FORBIDDEN'});
  for(const [reply,expectedCode] of [
    [()=>({code:1,stdout:''}),'GIT_FAILED'],
    [spec=>({code:1,stdout:typed(spec,{status:'error',errno:'EACCES'})}),'GIT_FAILED'],
    [()=>({code:null,stdout:''}),'ETIMEDOUT'],
    [()=>({code:2,stdout:''}),'GIT_FAILED'],
    [()=>({code:0,stdout:'not-json'}),'GIT_FAILED'],
    [spec=>({code:0,stdout:typed(spec,{nonce:'0'.repeat(32)})}),'GIT_FAILED'],
    [spec=>({code:0,stdout:typed(spec,{uid:0})}),'GIT_FAILED'],
    [spec=>({code:0,stdout:typed(spec,{extra:true})}),'GIT_FAILED'],
    [spec=>({code:0,stdout:typed(spec,{status:'error',errno:'EIO'})}),'EIO'],
    [spec=>({code:0,stdout:typed(spec,{status:'error',errno:'EMFILE'})}),'EMFILE'],
    [spec=>({code:0,stdout:typed(spec,{status:'error',errno:'ENOENT'})}),'GIT_FAILED'],
  ])await assert.rejects(withOperatorCommands(operatorUser,()=>probeOperatorArchiveAccess(file,{runProbe:async spec=>reply(spec)})),{code:expectedCode});
  for(const code of ['EIO','EMFILE','ENFILE'])await assert.rejects(withOperatorCommands(operatorUser,()=>probeOperatorArchiveAccess(file,{runProbe:async()=>{throw Object.assign(Error('wrapper failure'),{code});}})),{code});
});

test('archive probe cancellation пробрасывается до интерпретации access decision',async t=>{
  t.mock.method(process,'geteuid',()=>0);
  const controller=new AbortController(),reason=Error('cancelled');
  await assert.rejects(withExecutionContext({signal:controller.signal},()=>withOperatorCommands(operatorUser,()=>probeOperatorArchiveAccess('/fixture/archive.bundle',{runProbe:async spec=>{
    controller.abort(reason);return {code:0,stdout:JSON.stringify({version:1,nonce:spec.nonce,uid:spec.uid,status:'error',errno:'EACCES'})};
  }}))),error=>error===reason);
  await withOperatorCommands(operatorUser,()=>assert.equal(operatorCommandSpec('/usr/bin/test',['-r','/fixture/archive.bundle']),null));
});
