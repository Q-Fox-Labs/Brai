// ABOUTME: Проверяет отказ отдельного runtime artifacts до открытия внешних ресурсов.
// ABOUTME: Запускает собственный subprocess без конфигурации и секретов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('runtime CLI fails safely on missing configuration without opening resources',async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/main.js',import.meta.url))],{env:{},stdio:['ignore','pipe','pipe']});let out='',error='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>error+=chunk);
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});let timer;
  try{const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Runtime startup failure did not finish')),5000);})]);assert.equal(result.code,1);assert.equal(result.signal,null);assert.equal(out,'');const record=JSON.parse(error.trim());assert.equal(record.event,'startup-failed');assert.equal(record.code,'STARTUP_FAILED');}
  finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited.catch(()=>{});}
});
