// ABOUTME: Регрессионные проверки bootstrap согласования, поколения и dispatch ролей.
// ABOUTME: Использует настоящий Control/privateCall и синтетические Auth/runtime порты.
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {Control,privateCall}=await import(new URL('../control.mjs',import.meta.url));

/** Собрать рассогласование root-профиля и Auth поколения. */
function bootstrapRuntime(profileRole,userRole,profileFields={},userFields={}){
 return {control:{},registry:async()=>({version:1,profiles:{1234:{userId:'owner',profileId:'profile',status:'active',role:profileRole,generation:1,...profileFields}}}),
  authCall:async()=>({user:{id:'owner',profileId:'profile',status:'provisioning',role:userRole,generation:2,...userFields}})};
}
test('old guest profile cannot bootstrap user during pending upgrade',async()=>{
 await assert.rejects(privateCall(bootstrapRuntime('guest','user'),'permissions.bootstrap',{uid:1234}),/FORBIDDEN/);
});
test('old user profile cannot bootstrap guest before restrictive mounts',async()=>{
 await assert.rejects(privateCall(bootstrapRuntime('user','guest'),'permissions.bootstrap',{uid:1234}),/FORBIDDEN/);
});
test('same role with stale prepared generation is rejected',async()=>{
 await assert.rejects(privateCall(bootstrapRuntime('user','user',{}, {status:'active',appliedGeneration:2}),'permissions.bootstrap',{uid:1234}),/FORBIDDEN/);
});
test('correct staged guest and user profiles bootstrap',async()=>{
 for(const role of ['guest','user']){
  const value=await privateCall(bootstrapRuntime(role,role,{status:'provisioning',generation:2}),'permissions.bootstrap',{uid:1234});
  assert.equal(value.role,role);assert.equal(value.generation,2);
 }
});
test('active no-op generation accepts its already applied profile',async()=>{
 const value=await privateCall(bootstrapRuntime('user','user',{}, {status:'active',appliedGeneration:1}),'permissions.bootstrap',{uid:1234});
 assert.equal(value.role,'user');assert.equal(value.generation,2);
});

/** Собрать настоящий Control с наблюдаемым handler и изменяемым Auth. */
function controlFixture(role='guest',name='diary_create') {
 const state={role,generation:1,status:'active',id:'sol-owner',profileId:'sol-profile',telegramId:'111'};
 const profile={status:'active',userId:state.id,profileId:state.profileId,telegramId:state.telegramId,role,generation:1};
 const observed={dispatches:0,listed:undefined,called:undefined};
 const control=new Control({origin:'https://sol.example',cursorKey:'x'.repeat(32),
  registry:async()=>({version:1,profiles:{'1234':profile}}),
  authCall:async()=>({user:{...state}}),
  perUserRuntime:async()=>({
   listTools:async()=>{observed.listed?.();return [{name}]},
   callTool:async()=>{observed.dispatches++;observed.called?.();return 'RESULT'}
  })});
 return {control,state,observed};
}
test('guest direct forbidden remote names never execute',async()=>{
 for(const name of ['terminal','code_execution','diary_create','goals_create','timer_start','browser_navigate','local_ai_models_install','brai_login','publish_file','unregistered']){
  const {control,observed}=controlFixture('guest',name);
  await assert.rejects(control.invokeTool(1234,name,{}),/FORBIDDEN/);
  assert.equal(observed.dispatches,0,name);
 }
});
test('unknown role fails before dispatch',async()=>{
 const {control,observed}=controlFixture('overlord','files_list');
 await assert.rejects(control.invokeTool(1234,'files_list',{}),/FORBIDDEN/);
 assert.equal(observed.dispatches,0);
});
test('guest registered files_list remains usable',async()=>{
 const {control,observed}=controlFixture('guest','files_list');
 assert.equal(await control.invokeTool(1234,'files_list',{}),'RESULT');
 assert.equal(observed.dispatches,1);
});
test('downgrade during discovery rejects before dispatch',async()=>{
 const {control,state,observed}=controlFixture('admin','local_ai_models_install');
 observed.listed=()=>{state.role='guest';state.generation++};
 await assert.rejects(control.invokeTool(1234,'local_ai_models_install',{}),/FORBIDDEN/);
 assert.equal(observed.dispatches,0);
});
test('generation change after dispatch rejects result',async()=>{
 const {control,state,observed}=controlFixture('user','files_list');
 observed.called=()=>{state.generation++};
 await assert.rejects(control.invokeTool(1234,'files_list',{}),/FORBIDDEN/);
 assert.equal(observed.dispatches,1);
});
test('creator keeps manager tool and user cannot call it',async()=>{
 for(const role of ['creator','admin','user']){
  const {control,observed}=controlFixture(role,'local_ai_models_install');
  if(role==='user')await assert.rejects(control.invokeTool(1234,'local_ai_models_install',{}),/FORBIDDEN/);
  else assert.equal(await control.invokeTool(1234,'local_ai_models_install',{}),'RESULT');
  assert.equal(observed.dispatches,role==='user'?0:1);
 }
});
