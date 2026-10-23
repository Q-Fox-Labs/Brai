// ABOUTME: Проверяет запуск установленных CLI и hook через стабильный symlink current.
// ABOUTME: Запускает обычный Node без второго Codex и без подключения к внешним службам.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('CLI and hook execute through a symlink to an immutable runtime',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'codeworks-entrypoint-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const current=path.join(root,'current');
  symlinkSync(fileURLToPath(new URL('../src/',import.meta.url)),current,'dir');
  const cli=spawnSync(process.execPath,[path.join(current,'cli.mjs'),'--help'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.match(cli.stdout,/Codeworks: prepare, status, sync, release, cleanup/);
  const hook=spawnSync(process.execPath,[path.join(current,'hook.mjs')],{encoding:'utf8',input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git status'}})});
  assert.equal(hook.status,0,hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout),{});
});
