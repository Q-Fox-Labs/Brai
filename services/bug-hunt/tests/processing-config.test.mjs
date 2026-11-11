// ABOUTME: Проверяет запрет внешней отправки без точной защищённой проекции.
// ABOUTME: Не читает закрытые runtime inputs и не вызывает реальные модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import {processingConfig,approvedProjection} from '../dist/config.js';
const observation={title:'Сбой чтения',operation:'прочитать',expected:'данные',observed:'пустой результат'};
const hash='a'.repeat(64);
test('external owner permission alone never exposes original observation',()=>{
 const off=processingConfig(undefined);
 assert.equal(off.enabled,false);assert.equal(off.classificationEnabled,false);
 assert.equal(approvedProjection(off,'owner',hash),null);
 const allowed=processingConfig({enabled:true,classificationEnabled:true,externalAllowedOwners:['owner']});
 assert.equal(approvedProjection(allowed,'owner',hash),null);
 const configured=processingConfig({...allowed,externalProjections:[{ownerId:'owner',inputHash:hash,text:'Synthetic sanitized report',excludedFields:['diagnostic_text'],policyVersion:'operator-1'}]});
 assert.equal(approvedProjection(configured,'foreign',hash),null);
 assert.equal(approvedProjection(configured,'owner','b'.repeat(64)),null);
 assert.equal(approvedProjection(configured,'owner',hash).text,'Synthetic sanitized report');
 assert.equal(approvedProjection({...configured,externalAllowedOwners:[]},'owner',hash),null);
});
test('invalid worker config cannot silently enable inference or drop budget bounds',()=>{
 for(const value of [null,[],{enabled:'true'},{typo:true},{heartbeatMs:10000,leaseMs:10000},{dailyLimits:{embedding:{owner:10,global:1}}}]){
  assert.throws(()=>processingConfig(value),/INVALID_PROCESSING_CONFIG/);
 }
 const common={classificationEnabled:true,externalAllowedOwners:['owner']};
 for(const text of ['https://private.example/report','Bearer private-token','password=private']){
  assert.throws(()=>processingConfig({...common,externalProjections:[{ownerId:'owner',inputHash:hash,text,excludedFields:[],policyVersion:'1'}]}),/INVALID_PROCESSING_CONFIG/);
 }
});

test('protected generation label cannot select another model, path or unbounded key',()=>{
 assert.equal(processingConfig(undefined).targetGeneration,'gemma2-symmetric-v1');
 assert.equal(processingConfig({targetGeneration:'gemma2-rebuild-2026-11'}).targetGeneration,'gemma2-rebuild-2026-11');
 for(const targetGeneration of ['',null,3,'../model','OTHER MODEL','x'.repeat(65)]){
  assert.throws(()=>processingConfig({targetGeneration}),/INVALID_PROCESSING_CONFIG/);
 }
 for(const modelSetting of [{selector:'different'},{embeddingModel:'different'},{generationMetadata:{model_id:'different'}}]){
  assert.throws(()=>processingConfig(modelSetting),/INVALID_PROCESSING_CONFIG/);
 }
});

test('protected automatic policy prepares new inputs without per-report configuration',()=>{
 const settings=processingConfig({classificationEnabled:true,externalAllowedOwners:['owner'],externalProjectionPolicy:'technical-fields-v1'});
 assert.deepEqual(settings.externalProjections,[]);
 for(const input of [observation,{...observation,observed:'новое проявление'}]){
  const result=approvedProjection(settings,'owner',hash,input);
  assert.ok(result.text.includes(input.observed));
  assert.equal(result.policy_version,'technical-fields-v1');
 }
 assert.equal(approvedProjection(settings,'foreign',hash,observation),null);
 assert.equal(approvedProjection({...settings,classificationEnabled:false},'owner',hash,observation),null);
 assert.equal(approvedProjection({...settings,externalProjectionPolicy:null},'owner',hash,observation),null);
 assert.throws(()=>processingConfig({externalProjectionPolicy:'send-raw'}),/INVALID_PROCESSING_CONFIG/);
 // Запрос наблюдения не может сам включить внешнюю политику.
 assert.equal(approvedProjection(processingConfig(undefined),'owner',hash,{...observation,externalProjectionPolicy:'technical-fields-v1'}),null);
});
test('exact reviewed projection still takes priority over the automatic policy',()=>{
 const settings=processingConfig({classificationEnabled:true,externalAllowedOwners:['owner'],externalProjectionPolicy:'technical-fields-v1',externalProjections:[{ownerId:'owner',inputHash:hash,text:'Reviewed replacement',excludedFields:['observed'],policyVersion:'reviewed-1'}]});
 assert.equal(approvedProjection(settings,'owner',hash,observation).text,'Reviewed replacement');
});

test('automatic projection omits source owner identifiers even for non-UUID identities',()=>{
 const settings=processingConfig({classificationEnabled:true,externalAllowedOwners:['legacy-owner-123'],externalProjectionPolicy:'technical-fields-v1'});
 const p=approvedProjection(settings,'legacy-owner-123',hash,{...observation,observed:'failure for legacy-owner-123'});
 assert.ok(!p.text.includes('legacy-owner-123'));assert.ok(p.excluded_fields.includes('observed'));
});
