// ABOUTME: Проверяет межпроцессную изоляцию disposable DB до migrate и TRUNCATE.
// ABOUTME: Второй fixture ожидает owner session lease; рабочие базы и настройки не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setup,configured} from './fixture.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('second process cannot truncate active fixture before owner lease is released',{skip:!configured,timeout:60000},async t=>{
 const f=await setup();let child,closed=false;
 const tmp=fileURLToPath(new URL('../../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});const root=await mkdtemp(tmp+'fixture-session-');
 t.after(async()=>{if(!closed)await f.close();if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await done;}await rm(root,{recursive:true,force:true});});
 const project=await f.project();
 const source=`import{setup}from${JSON.stringify(new URL('./fixture.mjs',import.meta.url).href)};import{writeFile}from'node:fs/promises';await writeFile(process.argv[2]+'/started','started');const f=await setup();try{await writeFile(process.argv[2]+'/acquired','acquired');}finally{await f.close();}`;
 const script=root+'/waiter.mjs';await writeFile(script,source);
 child=spawn(process.execPath,[script,root],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',bytes=>errors+=bytes);
 const done=new Promise(resolve=>child.once('close',code=>resolve(code))),deadline=Date.now()+30000;
 while(!await readFile(root+'/started','utf8').then(()=>true,()=>false)){assert.ok(Date.now()<deadline);await pause(50);}
 await pause(500);
 assert.equal(await readFile(root+'/acquired','utf8').then(()=>true,()=>false),false);
 assert.equal((await f.app.query('SELECT 1 FROM codeworks.projects WHERE id=$1',[project.id])).rowCount,1);
 await f.close();closed=true;
 assert.equal(await done,0,errors);assert.equal(await readFile(root+'/acquired','utf8'),'acquired');
});
