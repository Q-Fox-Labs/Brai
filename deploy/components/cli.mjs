// ABOUTME: Выполняет descriptor-driven build/check/package без повторной компиляции прежних входов.
// ABOUTME: Проверяет prepared output seal перед проверкой и упаковкой.
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { discover, fingerprints, json, validateDocumentation } from './graph.mjs';
import {buildOutputDigest, verifyBuildReceipt as verifyPreparedBuild, command} from './build-engine.mjs';
export {buildOutputInventory, buildOutputDigest} from './build-engine.mjs';
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function verifyBuildReceipt(root,c,state,build) {
  if(!c.commands.build)return;
  verifyPreparedBuild(root,c,state??json(join(root,'tmp/component-state',c.id+'.json')),build??fingerprints(root,c).build);
}
function saveState(path,state) {
  const temporary=path+'.'+randomUUID();
  writeFileSync(temporary,JSON.stringify(state)+'\n');
  renameSync(temporary,path);
}
function checkKey(c,item) {
  if(!c.commands.checkTools?.length)return null;
  const tools=[];
  for(const name of c.commands.checkTools) {
    const found=spawnSync('which',[name],{encoding:'utf8'});
    if(found.status!==0 || !found.stdout.trim())return null;
    try {
      const path=realpathSync(found.stdout.trim());
      tools.push({name,path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
    } catch {return null;}
  }
  const environment=Object.entries(process.env).sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({checks:item.checks,tools,environment,node:process.execPath,nodeVersion:process.version})).digest('hex');
}
export async function execute(root, action, ids=[], {base,includeDependencies=true}={}) {
  const graph=discover(root,{base,allowMissingBuildOutputs:action!=='validate'});
  validateDocumentation(root,graph);
  const selected=new Set();
  function include(id) {
    const c=graph.components.get(id);
    if (!c || c.status!=='active') throw Error(`UNKNOWN_COMPONENT: ${id}`);
    if (selected.has(id)) return;
    selected.add(id);
    if(includeDependencies)for (const dep of c.dependencies) include(dep.id);
  }
  for (const id of ids.length?ids:graph.order) include(id);
  if (action==='validate') return {components:graph.order};
  const plan=graph.order.filter(id=>selected.has(id)).map(id=>({id,...fingerprints(root,graph.components.get(id))}));
  if (action==='plan') return plan;
  if (!['build','check','package','run'].includes(action)) throw Error('USAGE: cli.mjs validate|plan|build|check|package|run [component IDs] [--base Git-ref]');
  const stateRoot=join(root,'tmp','component-state'); mkdirSync(stateRoot,{recursive:true});
  const results=[];
  for (let item of plan) {
    const c=graph.components.get(item.id), statePath=join(stateRoot,item.id+'.json');
    const state=existsSync(statePath)?json(statePath):{};
    let compiled=false;
    // package also verifies build identity; check invokes only declared check commands, never npm test's legacy build prefix.
    let needsBuild=c.commands.build && state.build!==item.build;
    if(c.commands.build && !needsBuild) {
      try {verifyBuildReceipt(root,c,state,item.build);}
      catch(error) {if(['build','run'].includes(action))needsBuild=true;else throw error;}
    }
    if (needsBuild) {
      command(root,c,c.commands.build); compiled=true;
      state.outputDigest=buildOutputDigest(root,c);
    }
    // Generated payload and dependency outputs are fingerprinted after this compilation.
    item={id:item.id,...fingerprints(root,c)};
    state.build=item.build;
    saveState(statePath,state);
    let checked=false, checkProof;
    if (['check','run'].includes(action)) {
      // Only explicit checker contracts can reuse a result. Persist no environment values.
      const key=checkKey(c,item);
      if(key && state.checkReceipt?.key===key) checkProof='cached';
      else {command(root,c,c.commands.check);checkProof='executed';}
      verifyBuildReceipt(root,c,state,item.build);checked=true;
      if(fingerprints(root,c).checks!==item.checks || (key && checkKey(c,item)!==key))throw Error(`CHECK_INPUTS_CHANGED: ${c.id}`);
      state.checks=item.checks;state.checkReceipt=key?{key}:null;saveState(statePath,state);
    }
    let artifact,packaged=false;
    if (['package','run'].includes(action)) {
      const {packageComponent,verifyPackage}=await import('./package-runtime.mjs');
      const delivery={...c.delivery,files:[...new Set([...c.delivery.files,...c.dependencies.flatMap(d=>d.delivery)])]};
      if(state.runtime===item.runtime && state.packagePath && existsSync(state.packagePath)) artifact=verifyPackage(state.packagePath,c.id);
      else {artifact=await packageComponent(root,{...c,delivery},join(root,'tmp','component-packages'));packaged=true;}
      state.runtime=item.runtime;state.packagePath=artifact.path;saveState(statePath,state);
    }
    results.push({id:item.id,compiled,checked,checkProof,packaged,...item,artifact});
  }
  return results;
}
export async function main(args=process.argv.slice(2)) {
  const action=args.shift()??'validate';
  let base="refs/remotes/origin/dev",root=defaultRoot,includeDependencies=true; const ids=[];
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--base') {base=args[++i];if(!base)throw Error('BASE_REF_REQUIRED');}
    else if(args[i]==='--root') {root=resolve(args[++i]);}
    else if(args[i]==='--only') {includeDependencies=false;}
    else ids.push(args[i]);
  }
  console.log(JSON.stringify(await execute(root,action,ids,{base,includeDependencies}),null,2));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
