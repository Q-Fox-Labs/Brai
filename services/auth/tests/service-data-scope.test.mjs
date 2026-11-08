// ABOUTME: Проверяет namespace нового epoch и запрет произвольных profile identifiers.
// ABOUTME: Канонический owner не участвует в derivation и остаётся отдельным значением.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serviceDataScope, isServiceDataScope, SERVICE_DATA_EPOCH } from '../contracts/service-data-scope.mjs';
test('scope derives from a verified profile in a fresh epoch',()=>{
 const scope=serviceDataScope('profile-1');
 assert.equal(scope, 'brai-personal-v1:'+createHash('sha256').update(JSON.stringify([SERVICE_DATA_EPOCH,'profile-1'])).digest('hex'));
 assert.equal(isServiceDataScope(scope),true);
 assert.notEqual(scope,serviceDataScope('profile-2'));
 assert.ok(scope.length<=128);
 for(const value of [null,undefined,'','p q','p\0q','../p','😀','x'.repeat(129)])assert.throws(()=>serviceDataScope(value),/PROFILE_REQUIRED/);
 for(const value of ['canonical-owner','brai-personal-v1:'+ 'A'.repeat(64),scope+'extra'])assert.equal(isServiceDataScope(value),false);
});
