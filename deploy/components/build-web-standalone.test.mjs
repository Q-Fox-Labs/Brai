// ABOUTME: Проверяет границы файлов трассировки и автономного результата Next.
// ABOUTME: Тесты не запускают веб-сервис и не читают зависимости хоста.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateTraces,validateStandalone} from './build-web-standalone.mjs';

test('Next trace must resolve entirely inside the isolated source', t=>{
  const stage=mkdtempSync(join(tmpdir(),'web-trace-'));t.after(()=>rmSync(stage,{recursive:true,force:true}));
  const next=join(stage,'apps/web/.next');mkdirSync(next,{recursive:true});
  writeFileSync(join(stage,'safe.js'),'ok');
  const trace=join(next,'server.nft.json');
  writeFileSync(trace,JSON.stringify({files:['../../../safe.js']}));validateTraces(stage,next);
  writeFileSync(trace,JSON.stringify({files:['../../../../etc/passwd']}));assert.throws(()=>validateTraces(stage,next),/WEB_TRACE_ESCAPE/);
  symlinkSync('/etc/passwd',join(stage,'unsafe'));writeFileSync(trace,JSON.stringify({files:['../../../unsafe']}));
  assert.throws(()=>validateTraces(stage,next),/WEB_TRACE_ESCAPE/);
});

test('standalone output rejects links and environment files', t=>{
  const output=mkdtempSync(join(tmpdir(),'web-output-'));t.after(()=>rmSync(output,{recursive:true,force:true}));
  writeFileSync(join(output,'server.js'),'ok');validateStandalone(output);
  writeFileSync(join(output,'.env.local'),'secret');assert.throws(()=>validateStandalone(output),/WEB_OUTPUT_SECRET/);
  rmSync(join(output,'.env.local'));symlinkSync('/etc/passwd',join(output,'external'));
  assert.throws(()=>validateStandalone(output),/WEB_OUTPUT_SYMLINK/);
});
