// ABOUTME: Читает PR и проверки точного SHA, создаёт PR через установленный GitHub CLI.
// ABOUTME: Не сливает через REST без target guard, не создаёт статусы CI и не меняет защиту веток.
import { command } from './git.mjs';
import {executionFetch,executionContext} from './execution-context.mjs';
import { Fault,githubFailure,ciFailure } from './errors.mjs';
import { verifyCI,downloadProof } from './ci-verifier.mjs';
import { createRegistry } from '../ci/registry.mjs';
import {readCatalogKey,publishCatalog} from './ci-evidence.mjs';
const transientReadFailure=stderr=>{
  const status=String(stderr??'').match(/\bHTTP ([1-5][0-9]{2})\b/i);
  if(status)return ['502','503','504'].includes(status[1]);
  return /TLS handshake timeout|\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)\b|i\/o timeout|connection reset by peer|temporary failure in name resolution|unexpected EOF/i.test(stderr??'');
};
/** Подключает gh с существующей operator auth; stdout/stderr с секретами наружу не передаются. */
export function createGitHub({run=command,registryFactory=createRegistry,evidenceStore,catalogKeyFile=process.env.CODEWORKS_REUSE_PRIVATE_KEY_FILE,fetcher=executionFetch,now=Date.now}={}) {
  // One operation owns this adapter. Cache only content addressed reads, never live CI state.
  const immutableReads=new Map();
  const immutable=async(key,read)=>{
    if(!immutableReads.has(key)) {
      if(immutableReads.size>=1024)return read();
      const pending=Promise.resolve().then(read);
      immutableReads.set(key,pending);
      pending.catch(()=>immutableReads.delete(key));
    }
    return structuredClone(await immutableReads.get(key));
  };
  async function gate(project) {
    executionContext()?.signal?.throwIfAborted();
    const retry=await evidenceStore?.githubRetry?.(project);
    if(retry?.github_retry_at&&new Date(retry.github_retry_at).getTime()>now()) {
      const error=new Fault('GITHUB_RATE_LIMITED');error.retryAt=new Date(retry.github_retry_at).toISOString();throw error;
    }
  }
  async function failed(project,error) {
    executionContext()?.signal?.throwIfAborted();
    if(error.code==='GITHUB_RATE_LIMITED')await evidenceStore?.deferGitHub?.(project,error.retryAt);
    throw error;
  }
  const guardedFetch=project=>async(input,options)=>{
    await gate(project);
    let response;
    try{response=await fetcher(input,options);}
    catch(error){return failed(project,ciFailure(error));}
    if(!response.ok&&response.status!==404) {
      const body=response.status===403?await response.clone().text():'';
      return failed(project,githubFailure({status:response.status,headers:response.headers,body,now:now()}));
    }
    return response;
  };
  async function registryFor(project) {
    await gate(project);
    let auth;
    try{auth=await run('gh',['auth','token']);}
    catch(error){executionContext()?.signal?.throwIfAborted();throw new Fault('GITHUB_AUTH_REQUIRED');}
    if(auth.code||!auth.stdout?.trim())throw new Fault('GITHUB_AUTH_REQUIRED');
    const token=auth.stdout.trim();
    return {registry:registryFactory({repository:project.github.repository,username:project.github.repository.split('/')[0],token,fetcher:guardedFetch(project)}),readProof:artifact=>downloadProof({repository:project.github.repository,token},artifact,{fetcher:guardedFetch(project)})};
  }
  async function api(project,endpoint,{method='GET',body}={}) {
    const args=['api','--include','--method',method,'-H','Accept: application/vnd.github+json','repos/'+project.github.repository+'/'+endpoint];
    if(body)args.push('--input','-');
    const deadline=now()+120000;
    for(let attempt=0;attempt<2;attempt++) {
      await gate(project);
      let result;
      try{result=await run('gh',args,{input:body?JSON.stringify(body):undefined,allowFailure:true,timeout:Math.max(1,deadline-now())});}
      catch(error){return failed(project,ciFailure(error));}
      const raw=result.stdout??'',match=raw.match(/^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
      const headers={};
      if(match)for(const line of match[2].split(/\r?\n/)){const at=line.indexOf(':');if(at>0)headers[line.slice(0,at).toLowerCase()]=line.slice(at+1).trim();}
      const content=match?match[3]:raw,status=match?Number(match[1]):Number(result.stderr?.match(/\bHTTP ([1-5][0-9]{2})\b/i)?.[1])||undefined;
      if((result.code===undefined||result.code===0)&&(!status||status<400)) {
        try{return JSON.parse(content);}catch{throw new Fault('GITHUB_UNAVAILABLE');}
      }
      const error=githubFailure({status,headers,body:content+' '+(result.stderr??''),now:now()});
      if(error.code==='GITHUB_UNAVAILABLE'&&method==='GET'&&attempt===0&&now()<deadline&&(status>=500||transientReadFailure(result.stderr)))continue;
      return failed(project,error);
    }
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
    /** Publishes derived reusable evidence independently from the live CI verdict. */
    async publishCatalog(project) {
      const {registry}=await registryFor(project);
      const key=readCatalogKey(catalogKeyFile,project.github.ci.reuse_public_key);
      return publishCatalog(project,evidenceStore,registry,key);
    },
    /** Ищет единственный PR в выбранном состоянии по всем страницам. */
    async find(project,leg,{state='open',head}={}) {
      const owner=project.github.repository.split('/')[0];
      const matches=[];
      for(let page=1;page<=100;page++) {
        const prs=await api(project,'pulls?state='+state+'&per_page=100&head='+encodeURIComponent(owner+':'+leg.branch)+'&base='+encodeURIComponent(leg.target)+'&page='+page);
        if(!Array.isArray(prs))throw new Fault('GITHUB_UNAVAILABLE');
        matches.push(...prs.filter(pr=>!head||pr.head?.sha===head));
        if(matches.length>1)throw new Fault('PR_AMBIGUOUS','Multiple pull requests match the branch and target.');
        if(prs.length<100)return matches[0]??null;
      }
      throw new Fault('PR_AMBIGUOUS','Pull request search exceeded its page limit.');
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
          const {registry:rawRegistry,readProof}=await registryFor(project);
          const scope=project.github.repository;
          const registry={...rawRegistry,
            lookup:(id,ref)=>/^sha256:[0-9a-f]{64}$/.test(ref)?immutable(JSON.stringify([scope,'lookup',id,ref]),()=>rawRegistry.lookup(id,ref)):rawRegistry.lookup(id,ref),
            readJSON:(id,digest,name)=>immutable(JSON.stringify([scope,'json',id,digest,name]),()=>rawRegistry.readJSON(id,digest,name)),
          };
          const read=endpoint=>{
            if(!/^contents\/.+\?ref=[0-9a-f]{40}$/.test(endpoint))return api(project,endpoint);
            return immutable(JSON.stringify([scope,'contents',endpoint]),()=>api(project,endpoint));
          };
          verification=await verifyCI(project,sha,checks,{api:read,registry,readProof,readVerified:(id,attempt)=>evidenceStore?.read(project,id,attempt)??null,saveVerified:proof=>evidenceStore?.save(project,proof)});
        }catch(error){
          executionContext()?.signal?.throwIfAborted();
          const fault=ciFailure(error);
          verification={verified:false,state:fault.code==='GITHUB_UNAVAILABLE'?'CI_VERIFICATION_UNAVAILABLE':fault.code,retryAt:fault.retryAt};
        }
        const policy=project.github.ci;
        for(const row of rows)if(row.name===policy.check_name&&row.app_id===policy.app_id) {
          row.ci_verified=verification.verified;row.ci_state=verification.state;
          if(verification.retryAt)row.ci_retry_at=verification.retryAt;
          if(verification.verified)row.ci_evidence=verification.evidence;
          else row.conclusion=null;
        }
      }
      return rows;
    },
  };
}
