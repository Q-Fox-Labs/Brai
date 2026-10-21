// ABOUTME: Owner CLI удостоверяет настоящий CI exact SHA и сохраняет долговечное evidence/catalog.
// ABOUTME: Не принимает proof от агента, не создаёт check и не означает установленный выпуск.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {createGitHub} from './github.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
export async function verifyRegisteredCI(db,projectId,sha) {
  if(!/^[0-9a-f]{40}$/.test(sha))throw Error('EXACT_SHA_REQUIRED');
  const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
  if(!project?.github?.ci?.reuse_public_key)throw Error('PINNED_CI_POLICY_REQUIRED');
  const rows=await createGitHub({evidenceStore:createCIEvidence(db)}).checks(project,sha);
  return rows.find(c=>c.name===project.github.ci.check_name&&c.app_id===project.github.ci.app_id)??{ci_verified:false,ci_state:'EXACT_CI_CHECK_REQUIRED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    const connectionString=process.env.CODEWORKS_DATABASE_URL??JSON.parse(readFileSync(process.env.CODEWORKS_DATABASE_CONFIG_FILE,'utf8')).app_url;
    pool=new Pool({connectionString,max:1,connectionTimeoutMillis:3000});
    const result=await verifyRegisteredCI(pool,process.argv[2],process.argv[3]);
    console.log(JSON.stringify(result));if(!result.ci_verified)process.exitCode=1;
  }catch{console.error('CI owner verification unavailable; no CI success or installation claimed.');process.exitCode=1;}
  finally{await pool?.end();}
}
