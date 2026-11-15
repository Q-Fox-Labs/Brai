// ABOUTME: Независимо проверяет Auth email grant и поколение выдаваемой cookie.
// ABOUTME: Проверяет compiled web-access с синтетическими PostgreSQL/BetterAuth портами.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {captureEmailGrant,confirmEmailSession,permitsWebSession}=await import(new URL('../dist/web-access.js',import.meta.url));

/** Выдать ответы SQL-порта, сохраняя реальные вызовы и state transitions. */
function fixture({registry=true,linked=true,role='user',generation=7}={}){
 const state={registry,linked,role,generation,status:'active',userId:'sol-email',sessionId:'sol-session',stamps:[],deletes:0};
 const response=rows=>({rows,rowCount:rows.length});
 async function query(sql,params=[]){
  if(sql.startsWith('BEGIN')||sql.startsWith('COMMIT')||sql.startsWith('ROLLBACK')||sql.includes('pg_advisory_xact_lock'))return response([]);
  if(sql.includes('to_regclass'))return response([{registry:state.registry?'brai_identity':null}]);
  if(sql.startsWith('SELECT u.id,i.user_id'))return response([{id:state.userId,...(state.linked?{user_id:state.userId,role:state.role,status:state.status,lifecycle_generation:state.generation}:{})}]);
  if(sql.startsWith('SELECT id FROM "user"'))return response([{id:state.userId}]);
  if(sql.startsWith('SELECT 1 FROM brai_identity'))return response(state.linked?[{present:1}]:[]);
  if(sql.startsWith('SELECT role,status,lifecycle_generation'))return response(state.linked?[{role:state.role,status:state.status,lifecycle_generation:state.generation}]:[]);
  if(sql.startsWith('UPDATE "session"')){state.stamps.push(params[2]);state.sessionGeneration=params[2];return response([{id:state.sessionId}]);}
  if(sql.startsWith('DELETE FROM "session"')){state.deletes++;return response([]);}
  if(sql.includes('JOIN "session" s'))return response(state.linked&&state.status==='active'&&['creator','admin','user'].includes(state.role)&&state.sessionGeneration===state.generation?[{id:state.userId,role:state.role,status:state.status}]:[]);
  throw new Error('unexpected SQL '+sql);
 }
 const pool={query,connect:async()=>({query,release(){}})};
 const cfg={origin:'https://sol.example',identityMode:'email'};
 const handler=async()=>new Response(JSON.stringify({user:{id:state.userId},session:{id:state.sessionId}}),{status:200,headers:{'content-type':'application/json'}});
 return {state,pool,cfg,handler,headers:new Headers({cookie:'synthetic-cookie'})};
}
test('legacy email without registry keeps existing session',async()=>{
 const f=fixture({registry:false,linked:false});
 assert.equal(await permitsWebSession(f.pool,f.cfg,f.handler,f.headers),true);
 const grant=await captureEmailGrant(f.pool,' Sol@Example.org ');
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,grant),true);
 assert.deepEqual(f.state.stamps,[]);
});
test('unlinked email remains allowed when product registry exists',async()=>{
 const f=fixture({linked:false});
 assert.equal(await permitsWebSession(f.pool,f.cfg,f.handler,f.headers),true);
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,await captureEmailGrant(f.pool,'sol@example.org')),true);
});
test('guest linked email is denied at grant and session',async()=>{
 const f=fixture({role:'guest'});
 assert.equal((await captureEmailGrant(f.pool,'sol@example.org')).allowed,false);
 assert.equal(await permitsWebSession(f.pool,f.cfg,f.handler,f.headers),false);
});
test('active linked user receives captured generation only',async()=>{
 const f=fixture();const grant=await captureEmailGrant(f.pool,'sol@example.org');
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,grant),true);
 assert.deepEqual(f.state.stamps,[7]);
});
test('downgrade then upgrade during OTP does not adopt new generation',async()=>{
 const f=fixture();const grant=await captureEmailGrant(f.pool,'sol@example.org');
 f.state.generation=9;
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,grant),false);
 assert.deepEqual(f.state.stamps,[]);assert.equal(f.state.deletes,1);
});
test('identity introduced after OTP start cannot use unlinked grant',async()=>{
 const f=fixture({linked:false});const grant=await captureEmailGrant(f.pool,'sol@example.org');
 f.state.linked=true;
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,grant),false);
 assert.equal(f.state.deletes,1);
});
test('different session owner cannot use captured grant',async()=>{
 const f=fixture();const grant=await captureEmailGrant(f.pool,'sol@example.org');
 f.state.userId='another-user';
 assert.equal(await confirmEmailSession(f.pool,f.cfg,f.handler,f.headers,grant),false);
 assert.equal(f.state.deletes,1);
});
