// ABOUTME: Проверяет определение влияния изменения на веб и общий backend превью.
// ABOUTME: Проверки отделены от файловой системы и не выполняют сборку.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {classifyWebChanges,previewLockClosure} from '../src/preview-ports.mjs';
const component={inputs:{build:['apps/web/tsconfig.json'],runtime:['apps/web/app/**'],checks:['apps/web/tests/**']},dependencies:[{id:'auth',inputs:['services/auth/schemas/**']}],npm:{workspaces:['apps/web']},delivery:{kind:'oci-context'},commands:{build:'build',check:'test'}};
test('web runtime и dependency contracts запускают превью, только тесты — нет',()=>{
 assert.deepEqual(classifyWebChanges(component,component,['apps/web/tests/test.ts']),{web:false,backend:false});
 assert.deepEqual(classifyWebChanges(component,component,['apps/web/app/page.ts']),{web:true,backend:false});
 assert.deepEqual(classifyWebChanges(component,component,['services/auth/schemas/api.json']),{web:true,backend:true});
 assert.deepEqual(classifyWebChanges(component,component,['services/auth/src/auth.ts']),{web:false,backend:true});
 const testsOnly={...component,inputs:{...component.inputs,checks:['apps/web/tests/new.test.ts']}};
 assert.deepEqual(classifyWebChanges(component,testsOnly,['apps/web/component.json']),{web:false,backend:false});
});

test('lockfile учитывает только зависимости сборки веба и игнорирует чужой пакет',()=>{
 const lock={lockfileVersion:3,packages:{'apps/web':{dependencies:{next:'1'}},'node_modules/next':{version:'1'},'node_modules/other':{version:'1'}}};
 const changed=structuredClone(lock);changed.packages['node_modules/other'].version='2';
 assert.deepEqual(previewLockClosure(lock,['apps/web']),previewLockClosure(changed,['apps/web']));
 changed.packages['node_modules/next'].version='2';
 assert.notDeepEqual(previewLockClosure(lock,['apps/web']),previewLockClosure(changed,['apps/web']));
 assert.equal(classifyWebChanges(component,component,['package-lock.json'],{lockChanged:false}).web,false);
 assert.equal(classifyWebChanges(component,component,['package-lock.json'],{lockChanged:true}).web,true);
});
