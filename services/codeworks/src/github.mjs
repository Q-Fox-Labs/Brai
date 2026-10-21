// ABOUTME: Читает PR и проверки точного SHA, создаёт PR через установленный GitHub CLI.
// ABOUTME: Не сливает через REST без target guard, не создаёт статусы CI и не меняет защиту веток.
import { command } from './git.mjs';
import { Fault } from './errors.mjs';
/** Подключает gh с существующей operator auth; stdout/stderr с секретами наружу не передаются. */
export function createGitHub({run=command}={}) {
  async function api(project,endpoint,{method='GET',body}={}) {
    const args=['api','--method',method,'-H','Accept: application/vnd.github+json','repos/'+project.github.repository+'/'+endpoint];
    if(body)args.push('--input','-');
    let result;
    try{result=await run('gh',args,{input:body?JSON.stringify(body):undefined});}
    catch{throw new Fault('GITHUB_UNAVAILABLE','GitHub response unavailable; reconcile the recorded intent.');}
    try{return JSON.parse(result.stdout);}catch{throw new Fault('GITHUB_UNAVAILABLE');}
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
      return doc.check_runs.map(c=>({name:c.name,app_id:c.app?.id,sha:c.head_sha,status:c.status,conclusion:c.conclusion}));
    },
  };
}
