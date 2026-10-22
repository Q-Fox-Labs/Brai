// ABOUTME: Проверяет подпись owner catalog и точное членство immutable OCI references.
// ABOUTME: Ключи Ed25519 создаются в памяти; GitHub и registry не используются.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {catalogContains, signCatalog, verifyCatalog} from './catalog.mjs';

const repository='owner/repo',recipe='a'.repeat(64),key='b'.repeat(64),digest='sha256:'+'c'.repeat(64),source='d'.repeat(40);
const metadata={repository,recipe,kind:'runtime',key,source,runId:'123',attempt:'1'};
function catalog() {
  return {format:'brai-verified-ci-catalog-v1',repository,recipe,entries:[{id:'probe',digest,...metadata}]};
}

test('verified catalog signature binds payload, repository, recipe and exact OCI identity',()=>{
  const pair=generateKeyPairSync('ed25519'),foreign=generateKeyPairSync('ed25519');
  const document=signCatalog(catalog(),pair.privateKey);
  const publicKey=pair.publicKey.export({type:'spki',format:'pem'}),foreignPublicKey=foreign.publicKey.export({type:'spki',format:'pem'});
  assert.equal(verifyCatalog(document,publicKey,{repository,recipe}),true);
  assert.equal(catalogContains(document,'probe',{digest,metadata}),true);
  assert.equal(catalogContains(document,'other',{digest,metadata}),false);
  assert.equal(catalogContains(document,'probe',{digest:'sha256:'+'e'.repeat(64),metadata}),false);

  const tamperedPayload=structuredClone(document);tamperedPayload.catalog.entries[0].key='f'.repeat(64);
  assert.equal(verifyCatalog(tamperedPayload,publicKey,{repository,recipe}),false);
  const tamperedSignature={...document,signature:(document.signature[0]==='A'?'B':'A')+document.signature.slice(1)};
  assert.equal(verifyCatalog(tamperedSignature,publicKey,{repository,recipe}),false);
  assert.equal(verifyCatalog(document,foreignPublicKey,{repository,recipe}),false);
  assert.equal(verifyCatalog(document,publicKey,{repository:'other/repo',recipe}),false);
  assert.equal(verifyCatalog(document,publicKey,{repository,recipe:'e'.repeat(64)}),false);
});
