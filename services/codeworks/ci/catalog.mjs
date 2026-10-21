// ABOUTME: Проверяет долговечный owner-signed reuse catalog без npm и серверного private key.
// ABOUTME: Подпись закрепляет только ранее проверенные exact CI digest; labels не создают доверия.
import {createPublicKey,sign,verify} from 'node:crypto';
// Stable v1 namespace: first owner publication links the repository before access inheritance.
export const catalogPackage='catalog-v1';
export const catalogBytes=catalog=>Buffer.from(JSON.stringify(catalog));
export function signCatalog(catalog,privateKey) {
  return {catalog,signature:sign(null,catalogBytes(catalog),privateKey).toString('base64')};
}
export function verifyCatalog(document,publicKey,{repository,recipe}) {
  try {
    const key=createPublicKey(publicKey);
    if(key.asymmetricKeyType!=='ed25519'||!verify(null,catalogBytes(document.catalog),key,Buffer.from(document.signature,'base64')))return false;
    const c=document.catalog;
    return c.format==='brai-verified-ci-catalog-v1'&&c.repository===repository&&c.recipe===recipe&&Array.isArray(c.entries)&&c.entries.length<=10000&&c.entries.every(e=>e.repository===repository&&e.recipe===recipe&&/^[a-z][a-z0-9-]*$/.test(e.id)&&['runtime','build','check'].includes(e.kind)&&/^[0-9a-f]{64}$/.test(e.key)&&/^sha256:[0-9a-f]{64}$/.test(e.digest)&&/^[0-9a-f]{40}$/.test(e.source)&&/^[1-9][0-9]*$/.test(e.runId)&&/^[1-9][0-9]*$/.test(e.attempt));
  }catch{return false;}
}
export function catalogContains(document,id,hit) {
  const m=hit.metadata;
  return document?.catalog?.entries.some(e=>e.id===id&&e.digest===hit.digest&&['repository','recipe','kind','key','source','runId','attempt'].every(k=>e[k]===m[k]))??false;
}
