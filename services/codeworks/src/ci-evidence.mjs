// ABOUTME: Сохраняет первично удостоверенные CI proofs в собственной PG и экспортирует подписанный catalog.
// ABOUTME: Owner private key читается из закрытого файла; agent API и входные отчёты не имеют write-port.
import {readFileSync,lstatSync} from 'node:fs';
import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';
import {signCatalog,catalogPackage} from '../ci/catalog.mjs';
import {canonical} from './ci-verifier.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const policyHash=p=>hash(JSON.stringify(canonical(p.github.ci)));
/** db принадлежит owner worker; insert conflict обязан совпасть, evidence не переписывается. */
export function createCIEvidence(db) {
  return {
    async read(project,runId,attempt) {
      return (await db.query('SELECT proof FROM codeworks.verified_ci WHERE project_id=$1 AND run_id=$2 AND attempt=$3 AND policy_sha256=$4',[project.id,String(runId),String(attempt),policyHash(project)])).rows[0]?.proof??null;
    },
    async save(project,proof) {
      const c=proof.composition;
      await db.query('INSERT INTO codeworks.verified_ci(project_id,run_id,attempt,policy_sha256,proof) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[project.id,c.runId,c.attempt,policyHash(project),proof]);
      const saved=await this.read(project,c.runId,c.attempt);
      // jsonb меняет порядок ключей: сравниваются канонические JSON значения.
      if(JSON.stringify(canonical(saved))!==JSON.stringify(canonical(proof)))throw Error('CI_DURABLE_PROOF_CONFLICT');
    },
    async catalog(project) {
      const rows=(await db.query('SELECT proof FROM codeworks.verified_ci WHERE project_id=$1 AND policy_sha256=$2 ORDER BY created_at,run_id,attempt',[project.id,policyHash(project)])).rows;
      const entries=new Map();
      for(const {proof} of rows)for(const c of proof.composition.components)for(const kind of ['artifact','check',...(c.build?['build']:[])]) {
        const ref=c[kind],m=ref.metadata;
        entries.set([c.id,m.kind,m.key,ref.digest].join('/'),{id:c.id,digest:ref.digest,...Object.fromEntries(['repository','recipe','kind','key','source','runId','attempt'].map(k=>[k,m[k]]))});
      }
      return {format:'brai-verified-ci-catalog-v1',repository:project.github.repository,recipe:project.github.ci.recipe_sha256,entries:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v)};
    },
  };
}
/** Не создаёт/ротирует ключ: Ansible create-once и защищённый backup — отдельный owner lifecycle. */
export function readCatalogKey(path,expectedPublicKey) {
  if(!path)throw Error('CI_CATALOG_PRIVATE_KEY_REQUIRED');
  const stat=lstatSync(path);
  if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid())throw Error('CI_CATALOG_PRIVATE_KEY_PERMISSIONS');
  const key=createPrivateKey(readFileSync(path));
  if(key.asymmetricKeyType!=='ed25519'||createPublicKey(key).export({type:'spki',format:'pem'}).trim()!==expectedPublicKey?.trim())throw Error('CI_CATALOG_KEY_POLICY_MISMATCH');
  return key;
}
/** Deterministic content tag позволяет reconcile потерянный ответ без повторного build/runtime publish. */
export async function publishCatalog(project,store,registry,privateKey) {
  const document=signCatalog(await store.catalog(project),privateKey),key=hash(JSON.stringify(document)),tag='catalog-'+key;
  let hit=await registry.lookup(catalogPackage,tag);
  if(hit&&JSON.stringify(await registry.readJSON(catalogPackage,hit.digest,'catalog.json'))!==JSON.stringify(document))throw Error('CI_CATALOG_PUBLICATION_CONFLICT');
  // publishJSON пишет immutable content tag и только затем pointer; оба читаются по digest.
  hit=await registry.publishJSON(catalogPackage,tag,'catalog.json',document,{format:'brai-ci-catalog-v1',key},{alias:'verified-'+project.github.ci.recipe_sha256,existing:hit});
  return {reference:hit.reference,digest:hit.digest};
}
