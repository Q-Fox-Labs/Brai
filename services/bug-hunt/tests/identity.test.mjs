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

test('web reviewer follows current Auth role and status on every request',async()=>{
 let role='creator',status='active';
 const wire=async()=>({status:200,body:{user:{id:'owner-a',role,status},session:{userId:'owner-a',expiresAt:'2999-01-01T00:00:00Z'}}});
 const context={kind:'web',headers:{cookie:'synthetic'}};
 for(const [value,reviewer] of [['creator',true],['admin',true],['user',false],['guest',false],['unknown',false]]){
  role=value;assert.equal((await natsPrincipal(wire,context)).reviewer,reviewer);
 }
 status='blocked';await assert.rejects(natsPrincipal(wire,context),e=>e.code==='UNAUTHENTICATED');
});
