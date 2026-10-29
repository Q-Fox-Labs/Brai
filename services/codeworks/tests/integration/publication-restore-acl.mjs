// ABOUTME: Проверяет разделение app/verifier после реального восстановления disposable temporal DB.
// ABOUTME: Повторные миграции сохраняют узкий вызов lock helper и запрещают app запись доверенных данных.
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readConfig} from './fixture.mjs';
import {migrate} from '../../src/migrate.mjs';

const config=await readConfig();
if(config.fixture!=='temporal'||!config.verifier_url||!config.verifier_role)throw Error('TEMPORAL_VERIFIER_FIXTURE_REQUIRED');
const ownerUrl=new URL(config.restore_owner_url),appUrl=new URL(config.restore_app_url),verifierUrl=new URL(config.verifier_url);
if(ownerUrl.pathname!=='/brai_codeworks_temporal_restore_test'||appUrl.pathname!==ownerUrl.pathname||verifierUrl.pathname!=='/brai_codeworks_temporal_test'||verifierUrl.hostname!==appUrl.hostname||verifierUrl.port!==appUrl.port||decodeURIComponent(verifierUrl.username)!==config.verifier_role||config.verifier_role===config.app_role)throw Error('DISPOSABLE_RESTORE_REQUIRED');
verifierUrl.pathname=ownerUrl.pathname;
const owner=new Pool({connectionString:ownerUrl.toString()}),app=new Pool({connectionString:appUrl.toString()}),verifier=new Pool({connectionString:verifierUrl.toString()});
try{
  await migrate(owner,config.app_role,config.verifier_role);await migrate(owner,config.app_role,config.verifier_role);
  for(const table of ['installed','deployment_evidence','verified_ci'])for(const privilege of ['INSERT','UPDATE']){
    assert.equal((await app.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed',['codeworks.'+table,privilege])).rows[0].allowed,false);
  }
  assert.equal((await verifier.query("SELECT has_table_privilege(current_user,'codeworks.installed','UPDATE') AS allowed")).rows[0].allowed,true);
  assert.equal((await verifier.query("SELECT has_table_privilege(current_user,'codeworks.deployment_evidence','INSERT') AS allowed")).rows[0].allowed,true);
  assert.equal((await app.query("SELECT has_function_privilege(current_user,'codeworks.lock_publication_evidence(text,uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed,true);
  assert.equal((await owner.query("SELECT has_function_privilege('public','codeworks.lock_publication_evidence(text,uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed,false);
  const definer=(await owner.query("SELECT prosecdef,proconfig,pg_get_userbyid(proowner)=current_user AS owned FROM pg_proc WHERE oid='codeworks.lock_publication_evidence(text,uuid,uuid)'::regprocedure")).rows[0];
  assert.equal(definer.prosecdef,true);assert.equal(definer.owned,true);assert.deepEqual(definer.proconfig,['search_path=pg_catalog']);
  await assert.rejects(app.query("UPDATE codeworks.installed SET composition=composition WHERE false"),{code:'42501'});
  await assert.rejects(app.query("UPDATE codeworks.deployment_evidence SET evidence_url=evidence_url WHERE false"),{code:'42501'});
  console.log('Restored disposable database retains verifier-only writes and the restricted publication lock.');
}finally{await Promise.all([owner.end(),app.end(),verifier.end()]);}
