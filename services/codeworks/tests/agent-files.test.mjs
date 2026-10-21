// ABOUTME: Проверяет preflight полного batch на настоящем Python file worker.
// ABOUTME: Невалидная поздняя операция не должна оставить раннюю запись.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('batch preflight rejects invalid late operations before writing earlier files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'codeworks-files-'));
  try {
    await mkdir(path.join(root,'directory'));
    await writeFile(path.join(root,'existing.txt'),'preserved');
    const invalid=[
      {op:'rename',path:'existing.txt'},
      {op:'write',path:'directory',content:'invalid'},
      {op:'delete',path:'directory'},
      {op:'symlink',path:'existing.txt',target:'directory'},
    ];
    for(const operation of invalid) {
      const result=spawnSync('/usr/bin/python3',[fileURLToPath(new URL('../src/agent-files.py',import.meta.url))],{input:JSON.stringify({root,action:'batch',operations:[{op:'write',path:'partial.txt',content:'must not appear'},operation]}),encoding:'utf8',timeout:5000});
      assert.equal(result.status,1);
      assert.deepEqual(JSON.parse(result.stdout),{error:'FILE_OPERATION_REJECTED'});
      await assert.rejects(readFile(path.join(root,'partial.txt')));
      assert.equal(await readFile(path.join(root,'existing.txt'),'utf8'),'preserved');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Unix restart reclaims only own stale socket, preserving live endpoints and ordinary files',async()=>{
 const {reclaimSocket}=await import('../src/agent-host.mjs');
 const {createServer}=await import('node:net');
 const {spawn}=await import('node:child_process');
 const root=await mkdtemp(path.join(tmpdir(),'codeworks-socket-')),file=path.join(root,'endpoint.sock');
 const server=createServer(stream=>stream.destroy());let child;
 try{
  await writeFile(file,'foreign ordinary file');
  await assert.rejects(reclaimSocket(file),/SOCKET_OCCUPIED/);assert.equal(await readFile(file,'utf8'),'foreign ordinary file');await rm(file);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
  await assert.rejects(reclaimSocket(file),/SOCKET_OCCUPIED/);
  await new Promise(resolve=>server.close(resolve));
  child=spawn(process.execPath,['--input-type=module','-e',"import{createServer}from'node:net';createServer().listen(process.argv[1],()=>process.stdout.write('ready'));",file],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('SOCKET_FIXTURE_EXITED')));});
  const dead=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await dead;
  await reclaimSocket(file);await reclaimSocket(file);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
 }finally{if(child?.exitCode===null&&!child?.signalCode)child.kill('SIGKILL');if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
