// ABOUTME: Проверяет запрет внешней отправки без точной защищённой проекции.
// ABOUTME: Не читает закрытые runtime inputs и не вызывает реальные модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import {processingConfig,approvedProjection} from '../dist/config.js';
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
