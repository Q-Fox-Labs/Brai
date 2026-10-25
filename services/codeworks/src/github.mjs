// ABOUTME: Читает PR и проверки точного SHA, создаёт PR через установленный GitHub CLI.
// ABOUTME: Не сливает через REST без target guard, не создаёт статусы CI и не меняет защиту веток.
import { command } from './git.mjs';
import {executionFetch} from './execution-context.mjs';
import { Fault } from './errors.mjs';
import { verifyCI,downloadProof } from './ci-verifier.mjs';
import { createRegistry } from '../ci/registry.mjs';
import {readCatalogKey,publishCatalog} from './ci-evidence.mjs';
const transientReadFailure=stderr=>{
  const status=String(stderr??'').match(/\bHTTP ([1-5][0-9]{2})\b/i);
  if(status)return ['502','503','504'].includes(status[1]);
  return /TLS handshake timeout|\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b|i\/o timeout|connection reset by peer|temporary failure in name resolution|unexpected EOF/i.test(stderr??'');
};
/** Подключает gh с существующей operator auth; stdout/stderr с секретами наружу не передаются. */
export function createGitHub({run=command,registryFactory=createRegistry,evidenceStore,catalogKeyFile=process.env.CODEWORKS_REUSE_PRIVATE_KEY_FILE}={}) {
  async function api(project,endpoint,{method='GET',body}={}) {
    const args=['api','--method',method,'-H','Accept: application/vnd.github+json','repos/'+project.github.repository+'/'+endpoint];
    if(body)args.push('--input','-');
    let result;
    try{
      const deadline=Date.now()+120000;
      for(let attempt=0;attempt<2;attempt++) {
        const remaining=deadline-Date.now();
        if(remaining<=0)throw Error('READ_BUDGET_EXHAUSTED');
        result=await run('gh',args,{input:body?JSON.stringify(body):undefined,...(method==='GET'?{allowFailure:true,timeout:remaining}:{})});
        if(result.code===undefined||result.code===0)break;
        if(method!=='GET'||attempt===1||!transientReadFailure(result.stderr))throw Error('READ_UNAVAILABLE');
      }
    }
    catch{throw new Fault('GITHUB_UNAVAILABLE','GitHub response unavailable; reconcile the recorded intent.');}
    try{return JSON.parse(result.stdout);}catch{throw new Fault('GITHUB_UNAVAILABLE');}
  }
  /** Separate branch pushes may create multiple suites for one SHA; only canonical runs can be ordered. */
  async function canonicalChecks(project,sha,checks) {
    const policy=project.github.ci,repository=project.github.repository;
    const candidates=checks.filter(c=>c.name===policy.check_name&&c.app?.id===policy.app_id&&c.head_sha===sha);
    if(candidates.length<2)return checks;
    const ids=new Set(),runs=new Set();let selected,latest=0n;
    for(const check of candidates) {
      if(!Number.isSafeInteger(check.id)||check.id<1||ids.has(check.id))return checks;
      ids.add(check.id);
      let url;try{url=new URL(check.details_url);}catch{return checks;}
      const parsed=url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/\d+)?$/);
      if(url.origin!=='https://github.com'||!parsed||parsed[1].toLowerCase()!==repository.toLowerCase()||runs.has(parsed[2]))return checks;
      runs.add(parsed[2]);
      const run=await api(project,'actions/runs/'+parsed[2]);
      if(String(run.id)!==parsed[2]||run.head_sha!==sha||run.path!=='.github/workflows/codeworks.yml'||run.event!=='push'||run.repository?.full_name?.toLowerCase()!==repository.toLowerCase()||!Number.isInteger(run.run_attempt)||run.run_attempt<1)return checks;
      if(BigInt(parsed[2])>latest){latest=BigInt(parsed[2]);selected=check;}
    }
    // Never fall back to an older success: verifyCI checks the latest run's live status and exact proof.
    return checks.filter(c=>!candidates.includes(c)||c===selected);
  }
  return {
    /** Ищет и закрытые PR: потерянный ответ create не должен создавать дубль. */
    async find(project,leg) {
      const owner=project.github.repository.split('/')[0];
      const prs=await api(project,'pulls?state=all&per_page=100&head='+encodeURIComponent(owner+':'+leg.branch)+'&base='+leg.target);
      if(!Array.isArray(prs)||prs.length>1)throw new Fault('CONFLICT','Ambiguous pull request; resources retained.');
      return prs[0]??null;
    },
    get:(project,number)=>api(project,'pulls/'+number),
    /** Создаёт только после durable pr_attempted; при неопределённом ответе следующий проход только читает. */
    create:(project,leg,body)=>api(project,'pulls',{method:'POST',body:{title:'Codeworks: '+leg.branch+' → '+leg.target,head:leg.branch,base:leg.target,body}}),
    /** Принимает только checks зарегистрированного GitHub App, на точно запрошенном commit. */
    async checks(project,sha) {
      const doc=await api(project,'commits/'+sha+'/check-runs?per_page=100&filter=latest');
      if(!Array.isArray(doc.check_runs)||!Number.isInteger(doc.total_count)||doc.total_count!==doc.check_runs.length||doc.total_count>100)throw new Fault('CHECKS_BLOCKED','Checks are absent or exceed the bounded response.');
      let checks=doc.check_runs;
      let rows=checks.map(c=>({name:c.name,app_id:c.app?.id,sha:c.head_sha,status:c.status,conclusion:c.conclusion}));
      if(project.github.ci) {
        let verification;
        try {
          checks=await canonicalChecks(project,sha,checks);
          rows=checks.map(c=>({name:c.name,app_id:c.app?.id,sha:c.head_sha,status:c.status,conclusion:c.conclusion}));
          // AIDEV-NOTE: Токен остаётся в памяти owner process; не аргумент команды и не часть результата.
          const auth=await run('gh',['auth','token']);
          const registry=registryFactory({repository:project.github.repository,username:project.github.repository.split('/')[0],token:auth.stdout.trim(),fetcher:executionFetch});
          const files=new Map(),read=endpoint=>{
            if(!/^contents\/.+\?ref=[0-9a-f]{40}$/.test(endpoint))return api(project,endpoint);
            if(!files.has(endpoint))files.set(endpoint,api(project,endpoint));
            return files.get(endpoint);
          };
          verification=await verifyCI(project,sha,checks,{api:read,registry,readProof:artifact=>downloadProof({repository:project.github.repository,token:auth.stdout.trim()},artifact,{fetcher:executionFetch}),readVerified:(id,attempt)=>evidenceStore?.read(project,id,attempt)??null,saveVerified:proof=>evidenceStore?.save(project,proof)});
          if(verification.verified&&evidenceStore&&project.github.ci.reuse_public_key) {
            const key=readCatalogKey(catalogKeyFile,project.github.ci.reuse_public_key);
            await publishCatalog(project,evidenceStore,registry,key);
          }
        }catch{verification={verified:false,state:'CI_VERIFICATION_UNAVAILABLE'};}
        const policy=project.github.ci;
        for(const row of rows)if(row.name===policy.check_name&&row.app_id===policy.app_id) {
          row.ci_verified=verification.verified;row.ci_state=verification.state;
          if(verification.verified)row.ci_evidence=verification.evidence;
          else row.conclusion=null;
        }
      }
      return rows;
    },
  };
}
