// ABOUTME: Проверяет контракт нового lifecycle API, явные DTO и выбранные npm корни Temporal.
// ABOUTME: Не подменяет интеграционные испытания с настоящими Temporal и PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validate,methods,outputNames,expanded} from '../src/contracts.mjs';
import {lockInputs} from '../components/lock-inputs.mjs';
const id='0997203d-1266-4cf7-9668-d985b3eec801';
test('close/cancel are admitted mutations with exact attempt, reason and request key',()=>{
  const scope={project_id:'p',workspace_id:id,request_key:'close-1',reason:'Исправить задачу'};
  validate('release.close',{...scope,release_operation_id:id});validate('workspace.cancel',scope);
  for(const key of ['release_operation_id','reason','request_key']){
    const request={...scope,release_operation_id:id};delete request[key];assert.throws(()=>validate('release.close',request),{code:'INVALID_ARGUMENT'});
  }
  assert.throws(()=>validate('workspace.cancel',{...scope,rollback:true}),{code:'INVALID_ARGUMENT'});
  for(const method of methods)assert.ok(outputNames[method]);
  validate('lifecycleResponse',{workspace_id:id,task_status:'active',workflow:null,blockers:[]});
  assert.throws(()=>validate('statusResponse',{operation:{temporal_token:'secret'}}));
  assert.equal(expanded('release.close').additionalProperties,false);
});
test('explicit dot root packages SDK 1.24.0 without modifying manifests or selecting repository files',()=>{
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const entries=lockInputs(root,['services/codeworks','.']);
  for(const name of ['client','worker','workflow','activity','common'])assert.equal(entries.find(x=>x.key==='node_modules/@temporalio/'+name)?.entry.version,'1.24.0');
  assert.deepEqual(entries,lockInputs(root,['services/codeworks','']));
  const component=JSON.parse(readFileSync(new URL('../component.json',import.meta.url)));
  assert.ok(component.delivery.files.includes('services/codeworks/dist/workflows.js'));
  assert.equal(component.commands.build,'node src/build-workflows.mjs');
});
