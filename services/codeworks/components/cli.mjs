// ABOUTME: Descriptor-driven build/check/package with one compilation for unchanged build inputs.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discover, fingerprints, json } from './graph.mjs';
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
function command(root,c,text) {
  if (!text) return;
  const result=spawnSync(text,{cwd:join(root,c.directory),shell:true,stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:"1"}});
  if (result.error) throw result.error;
  if (result.status!==0) throw Error(`COMMAND_FAILED: ${c.id}: ${text}: ${result.status}`);
}
export async function execute(root, action, ids=[], {base}={}) {
  const graph=discover(root,{base});
  const selected=new Set();
  function include(id) {
    const c=graph.components.get(id);
    if (!c || c.status!=='active') throw Error(`UNKNOWN_COMPONENT: ${id}`);
    if (selected.has(id)) return;
    selected.add(id);
    for (const dep of c.dependencies) include(dep.id);
  }
  for (const id of ids.length?ids:graph.order) include(id);
  if (action==='validate') return {components:graph.order};
  const plan=graph.order.filter(id=>selected.has(id)).map(id=>({id,...fingerprints(root,graph.components.get(id))}));
  if (action==='plan') return plan;
  if (!['build','check','package','run'].includes(action)) throw Error('USAGE: cli.mjs validate|plan|build|check|package|run [component IDs] [--base Git-ref]');
  const stateRoot=join(root,'tmp','component-state'); mkdirSync(stateRoot,{recursive:true});
  const results=[];
  for (const item of plan) {
    const c=graph.components.get(item.id), statePath=join(stateRoot,item.id+'.json');
    const state=existsSync(statePath)?json(statePath):{};
    let compiled=false;
    // package also verifies build identity; check invokes only declared check commands, never npm test's legacy build prefix.
    const outputsPresent=c.delivery.files.filter(path=>path.includes('/dist') || path.includes('/.next')).every(path=>existsSync(join(root,path)));
    if (c.commands.build && (state.build!==item.build || !outputsPresent)) {
      command(root,c,c.commands.build); compiled=true;
    }
    state.build=item.build;
    writeFileSync(statePath,JSON.stringify(state)+'\n');
    let checked=false;
    if (['check','run'].includes(action)) {
      command(root,c,c.commands.check); checked=true;
      state.checks=item.checks; writeFileSync(statePath,JSON.stringify(state)+'\n');
    }
    let artifact,packaged=false;
    if (['package','run'].includes(action)) {
      const {packageComponent,verifyPackage}=await import('./package-runtime.mjs');
      const delivery={...c.delivery,files:[...new Set([...c.delivery.files,...c.dependencies.flatMap(d=>d.delivery)])]};
      if(state.runtime===item.runtime && state.packagePath && existsSync(state.packagePath)) artifact=verifyPackage(state.packagePath,c.id);
      else {artifact=await packageComponent(root,{...c,delivery},join(root,'tmp','component-packages'));packaged=true;}
      state.runtime=item.runtime;state.packagePath=artifact.path;writeFileSync(statePath,JSON.stringify(state)+'\n');
    }
    results.push({id:item.id,compiled,checked,packaged,...item,artifact});
  }
  return results;
}
export async function main(args=process.argv.slice(2)) {
  const action=args.shift()??'validate';
  let base="refs/remotes/origin/dev",root=defaultRoot; const ids=[];
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--base') {base=args[++i];if(!base)throw Error('BASE_REF_REQUIRED');}
    else if(args[i]==='--root') {root=resolve(args[++i]);}
    else ids.push(args[i]);
  }
  console.log(JSON.stringify(await execute(root,action,ids,{base}),null,2));
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
