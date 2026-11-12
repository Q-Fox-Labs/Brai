// ABOUTME: Предоставляет фиксированные root-only команды продолжения доказанных операций.
// ABOUTME: Не принимает программы, произвольные пути или неподтверждённые признаки завершения.
import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';
import {resumeCleanup,cleanupEvidenceDigest} from './cleanup-resume.mjs';
import {createGit} from './git.mjs';
import {createFlowGit} from './git-flow.mjs';
import {createBranchCleanup} from './branch-cleanup.mjs';
import {createCodeIndex} from './code-index.mjs';
import {repairWorkflow,createNativeRepairPorts} from './workflow-repair.mjs';
import {repairPostprocess,createPostprocessRepairAdapter} from './postprocess-repair.mjs';

export const repairMethods=['cleanup-resume-preflight','cleanup-resume','postprocess-preflight','postprocess-repair','workflow-repair'];
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
/** Разбирает один ограниченный JSON-запрос; команды и credentials не являются параметрами. */
export function parseRepairArgs(argv){
  if(!repairMethods.includes(argv[0]))throw Error('INVALID_ARGUMENT');
  const args={method:argv[0]};
  for(let i=1;i<argv.length;i++){
    const key=argv[i];
    if(!['--project','--request-json'].includes(key)||args[key]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');
    args[key]=argv[++i];
  }
  if(typeof args['--project']!=='string'||!args['--project'].length||Buffer.byteLength(args['--request-json']??'')>65536)throw Error('INVALID_ARGUMENT');
  try{args.request=JSON.parse(args['--request-json']);}catch{throw Error('INVALID_ARGUMENT');}
  if(!args.request||Array.isArray(args.request)||typeof args.request!=='object')throw Error('INVALID_ARGUMENT');
  return args;
}
function oneId(request,key){
  if(Object.keys(request).length!==1||!uuid(request[key]))throw Error('INVALID_ARGUMENT');
  return request[key];
}
/** Исполняет только привязанное к политике проекта восстановление; полномочия остаются root-only. */
export async function runRepairOperator(pool,args,{allowedRepositories=[],verifierPool:providedVerifier,workflowPorts,postprocessAdapter}={}){
  if(process.geteuid?.()!==0)throw Error('OWNER_REQUIRED');
  if(!repairMethods.includes(args.method))throw Error('INVALID_ARGUMENT');
  const projectId=args['--project'],request=args.request;
  const project=(await pool.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
  if(!project||!allowedRepositories.includes(project.repo_path))throw Error('REPAIR_PROJECT_FORBIDDEN');
  if(args.method==='cleanup-resume-preflight'){
    const id=oneId(request,'obligation_id');
    const item=(await pool.query('SELECT * FROM codeworks.cleanup_obligations WHERE id=$1 AND project_id=$2',[id,projectId])).rows[0];
    if(!item)throw Error('NOT_FOUND');
    return {obligation_id:id,expected_epoch:Number(item.epoch),evidence_sha256:cleanupEvidenceDigest(item),state:item.state,blocker:item.blocker};
  }
  if(args.method==='cleanup-resume')return resumeCleanup(pool,projectId,request,{
    git:{...createGit(),inspectBranchResources:createBranchCleanup().inspect},flowGit:createFlowGit(),codeIndex:createCodeIndex(pool),allowedRepositories,
  });
  if(args.method==='postprocess-preflight'){
    const id=oneId(request,'deployment_id');
    const known=(await pool.query('SELECT 1 FROM codeworks.deployments WHERE operation_id=$1 AND project_id=$2 AND NOT archived',[id,projectId])).rowCount;
    if(!known)throw Error('NOT_FOUND');
    const adapter=postprocessAdapter??createPostprocessRepairAdapter();
    if(!adapter?.preflight)throw Error('REPAIR_ADAPTER_REQUIRED');
    return adapter.preflight(id);
  }
  if(args.method==='postprocess-repair'){
    let verifier=providedVerifier;
    if(!verifier){
      if(!process.env.CODEWORKS_VERIFIER_DATABASE_URL)throw Error('VERIFIER_CONFIGURATION_REQUIRED');
      verifier=new Pool({connectionString:process.env.CODEWORKS_VERIFIER_DATABASE_URL,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
    }
    try{return await repairPostprocess(pool,projectId,request,{
      adapter:postprocessAdapter??createPostprocessRepairAdapter(),verifierPool:verifier,allowedRepositories,
    });}finally{if(verifier!==providedVerifier)await verifier.end();}
  }
  const ports=workflowPorts??await createNativeRepairPorts({
    address:process.env.CODEWORKS_TEMPORAL_ADDRESS,
    namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,
    taskQueue:process.env.CODEWORKS_TEMPORAL_TASK_QUEUE??process.env.CODEWORKS_TASK_QUEUE,
    bundlePath:process.env.CODEWORKS_WORKFLOW_BUNDLE??fileURLToPath(new URL('../dist/workflows.js',import.meta.url)),
    allowedRepositories,
  });
  try{return await repairWorkflow(pool,projectId,request,ports);}finally{if(!workflowPorts)await ports.close();}
}
