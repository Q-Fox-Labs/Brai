// ABOUTME: Проверяет уборку потомка, когда npm-подобный лидер уже завершился.
// ABOUTME: Создаёт собственную detached группу без сети, БД и приложения.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {stopChildGroup} from './process-group.mjs';
test('cleanup kills remaining group after leader exits',async()=>{
 const descendant="process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)";
 const program="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(descendant)+"],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.exit(0),500)";
 const child=spawn(process.execPath,['-e',program],{detached:true,stdio:['ignore','pipe','pipe']});
 let pid;
 try{
  const [chunk]=await once(child.stdout,'data');pid=Number(String(chunk).trim());assert.ok(pid>0);
  if(child.exitCode===null)await once(child,'exit');
  assert.equal(child.exitCode,0);
  await stopChildGroup(child);
  await new Promise(r=>setTimeout(r,100));
  try{const stat=await readFile('/proc/'+pid+'/stat','utf8');assert.equal(stat.slice(stat.lastIndexOf(') ')+2).split(' ')[0],'Z');}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }finally{await stopChildGroup(child);}
});
