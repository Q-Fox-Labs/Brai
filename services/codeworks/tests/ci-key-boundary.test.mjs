// ABOUTME: Проверяет существующий контракт защищённого файла ключа CI и подписи каталога.
// ABOUTME: Не требует удалённой оболочки агента; используются только временные синтетические ключи.
import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readCatalogKey} from '../src/ci-evidence.mjs';
import {signCatalog,verifyCatalog} from '../ci/catalog.mjs';

test('CI catalog key rejects broad permissions, symlinks and a different pinned public key',t=>{
  const root=mkdtempSync(path.join(tmpdir(),'codeworks-key-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pair=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
  const file=path.join(root,'identity.pem'),publicKey=pair.publicKey.export({type:'spki',format:'pem'});
  writeFileSync(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const catalog={format:'brai-verified-ci-catalog-v1',repository:'fixture/repo',recipe:'a'.repeat(64),entries:[]};
  const signed=signCatalog(catalog,readCatalogKey(file,publicKey));
  assert.equal(verifyCatalog(signed,publicKey,{repository:catalog.repository,recipe:catalog.recipe}),true);
  assert.equal(verifyCatalog({...signed,catalog:{...catalog,recipe:'b'.repeat(64)}},publicKey,{repository:catalog.repository,recipe:catalog.recipe}),false);
  assert.throws(()=>readCatalogKey(file,other.publicKey.export({type:'spki',format:'pem'})),/CI_CATALOG_KEY_POLICY_MISMATCH/);
  chmodSync(file,0o644);assert.throws(()=>readCatalogKey(file,publicKey),/CI_CATALOG_PRIVATE_KEY_PERMISSIONS/);
  chmodSync(file,0o600);symlinkSync(file,path.join(root,'link'));
  assert.throws(()=>readCatalogKey(path.join(root,'link'),publicKey),/CI_CATALOG_PRIVATE_KEY_PERMISSIONS/);
});
