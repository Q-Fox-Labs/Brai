// ABOUTME: Проверяет связывание credentials с owner и немедленный отзыв доступа.
// ABOUTME: Это изолированная проверка адаптера идентичности, а не доказательство живого Auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {codexPrincipal,natsPrincipal} from '../dist/identity.js';
test('credential, стабильный initiator и отзыв Auth/реестра проверяются на каждом вызове',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bug-hunt-identity-')),path=join(dir,'principals.json'),token='fixture-principal-token';
 const entry={tokenSha256:createHash('sha256').update(token).digest('hex'),ownerId:'owner-a',principalId:'stable',enabled:true};
 let active=true,calls=0;
 const wire=async()=>{calls++;return {user:{id:'owner-a',profileId:'profile-a',status:active?'active':'blocked',role:'admin'}};};
 try{
  await writeFile(path,JSON.stringify([entry]),{mode:0o600});
  const first=await codexPrincipal(wire,path,'Bearer '+token);assert.equal(first.ownerId,'owner-a');assert.equal(first.reviewer,false);
  assert.equal((await codexPrincipal(wire,path,'Bearer '+token)).actorId,first.actorId);assert.equal(calls,2);
  active=false;await assert.rejects(codexPrincipal(wire,path,'Bearer '+token),e=>e.code==='FORBIDDEN');
  active=true;await writeFile(path,JSON.stringify([{...entry,enabled:false}]));
  await assert.rejects(codexPrincipal(wire,path,'Bearer '+token),e=>e.code==='UNAUTHENTICATED');
  await assert.rejects(natsPrincipal(wire,{kind:'hermes',userId:'owner-a',profileId:'wrong'}),e=>e.code==='FORBIDDEN');
  await assert.rejects(natsPrincipal(wire,{kind:'hermes',userId:'owner-a',profileId:'profile-a',reviewer:true}),e=>e.code==='UNAUTHENTICATED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
