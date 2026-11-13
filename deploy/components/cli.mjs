// ABOUTME: Выполняет descriptor-driven build/check/package без повторной компиляции прежних входов.
// ABOUTME: Проверяет prepared output seal перед проверкой и упаковкой.
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, realpathSync, readdirSync, lstatSync, statSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { discover, fingerprints, checkGroupFingerprint, json, validateDocumentation } from './graph.mjs';
import {lockInputs} from './lock-inputs.mjs';
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
function dependencyInventory(root,c,development,cache) {
  if(process.env.NODE_PATH || process.env.NODE_OPTIONS)return null;
  const entries=lockInputs(root,c.npm.workspaces,{development});
  const cacheName=JSON.stringify(entries);
  if(cache.has(cacheName))return cache.get(cacheName);
  try {
    const digest=createHash('sha256');
    function visit(path,logical,ancestors) {
      const target=realpathSync(path),info=statSync(target);
      digest.update(JSON.stringify([logical,info.mode & 0o777,info.size,info.isDirectory()?'directory':'file'])).update('\0');
      if(info.isDirectory()) {
        if(ancestors.has(target))throw Error('DEPENDENCY_CYCLE');
        const next=new Set(ancestors).add(target);
        for(const name of readdirSync(target).sort()) {
          if(name==='node_modules')continue;
          if(/^\.env(?:\.|$)/.test(name) || ['.git','tmp','usercustom'].includes(name))throw Error('DEPENDENCY_UNQUALIFIED');
          visit(join(target,name),logical+'/'+name,next);
        }
      } else if(info.isFile())digest.update(readFileSync(target));
      else throw Error('DEPENDENCY_UNSUPPORTED');
    }
    for(const {key,entry} of entries) {
      if(!key.split('/').includes('node_modules'))continue;
      if(entry.link && realpathSync(join(root,key))!==realpathSync(join(root,entry.resolved)))throw Error('DEPENDENCY_WORKSPACE_CHANGED');
      visit(join(root,key),key,new Set());
    }
    const value=digest.digest('hex');cache.set(cacheName,value);return value;
  } catch {return null;}
}
function checkKey(c,item,toolCache) {
  if(!c.commands.checkTools?.length)return null;
  if(process.env.BRAI_NATIVE_ENGINE || process.env.BRAI_NATIVE_SOURCE || process.env.BRAI_COMPOSITION_BASE_ENGINE || c.commands.absentPaths?.some(path=>existsSync(path)))return null;
  if(c.commands.checkTools.includes('python3') && (!Array.isArray(c.commands.pythonModules) || !Array.isArray(c.commands.pythonAbsent)))return null;
  const tools=[];
  for(const name of [...new Set([...c.commands.checkTools,'sh'])]) {
    const found=spawnSync('/usr/bin/which',[name],{encoding:'utf8'});
    if(found.status!==0 || !found.stdout.trim())return null;
    try {
      const path=realpathSync(found.stdout.trim());
      const toolName=JSON.stringify({name,path});
      if(!toolCache.has(toolName)) {
        const stat=lstatSync(path);if(stat.uid!==0 || stat.mode & 0o022)return null;
        const bytes=readFileSync(path),digest=createHash('sha256').update(bytes);
        if(bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) {
          const dependencies=spawnSync('/usr/bin/ldd',[path],{encoding:'utf8'});
          if(dependencies.status!==0 || dependencies.stdout.includes('not found'))return null;
          const paths=[...dependencies.stdout.matchAll(/(?:=>\s*)?(\/[^\s()]+)/g)].map(match=>realpathSync(match[1]));
          for(const lib of [...new Set(paths)].sort()) {
            const info=lstatSync(lib);if(info.uid!==0 || info.mode & 0o022)return null;
            digest.update(lib).update('\0').update(readFileSync(lib));
          }
        }
        if(name==='git') {
          const result=spawnSync(path,['--exec-path'],{encoding:'utf8'});
          if(result.status!==0)return null;
          const dir=realpathSync(result.stdout.trim());
          const contents=new Map();
          function fileHash(file,info) {
            const identity=`${info.dev}:${info.ino}`;
            if(!contents.has(identity))contents.set(identity,createHash('sha256').update(readFileSync(file)).digest('hex'));
            return contents.get(identity);
          }
          function visitGit(file) {
            const info=lstatSync(file);
            if(info.uid!==0 || (!info.isSymbolicLink() && info.mode & 0o022))throw Error('UNQUALIFIED_GIT_PATH');
            digest.update(file).update('\0');
            if(info.isSymbolicLink()) {
              digest.update(readlinkSync(file));
              const target=realpathSync(file),targetInfo=lstatSync(target);
              if(!targetInfo.isFile() || targetInfo.uid!==0 || targetInfo.mode & 0o022)throw Error('UNQUALIFIED_GIT_PATH');
              digest.update(fileHash(target,targetInfo));
            }
            else if(info.isFile())digest.update(fileHash(file,info));
            else if(info.isDirectory())for(const entry of readdirSync(file).sort())visitGit(join(file,entry));
            else throw Error('UNQUALIFIED_GIT_PATH');
          }
          visitGit(dir);
        }
        toolCache.set(toolName,{name,path,sha256:digest.digest('hex')});
      }
      tools.push(toolCache.get(toolName));
      if(name==='python3') {
        if(Object.keys(process.env).some(key=>key.startsWith('PYTHON') || key==='VIRTUAL_ENV' || key.endsWith('_PYTHON')))return null;
        if(!Array.isArray(c.commands.pythonModules))return null;
        if(!Array.isArray(c.commands.pythonAbsent))return null;
        const cacheName=JSON.stringify({path,modules:c.commands.pythonModules,absent:c.commands.pythonAbsent});
        if(toolCache.has(cacheName)){tools.push(toolCache.get(cacheName));continue;}
        const probe=spawnSync(path,['-I','-B','-c',"import importlib.util,json,site,sys,sysconfig; mods=json.loads(sys.argv[1]); absent=json.loads(sys.argv[2]); specs=[importlib.util.find_spec(x) for x in mods]; print(json.dumps({'stdlib':sysconfig.get_path('stdlib'),'sitePaths':site.getsitepackages(),'userSite':site.getusersitepackages(),'presentAbsent':any(importlib.util.find_spec(x) is not None for x in absent),'modules':[None if s is None else (list(s.submodule_search_locations) if s.submodule_search_locations is not None else [s.origin]) for s in specs]}))",JSON.stringify(c.commands.pythonModules),JSON.stringify(c.commands.pythonAbsent)],{encoding:'utf8'});
        if(probe.status!==0)return null;
        const result=JSON.parse(probe.stdout);
        if(result.presentAbsent || existsSync(result.userSite) || result.modules.some(value=>!value || value.some(path=>!path || !path.startsWith('/usr/'))))return null;
        const paths=[result.stdlib,...result.modules.flat()];
        const pthAllowed={
          'distutils-precedence.pth':'2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224',
          'zope.interface-6.1-nspkg.pth':'4961151fe8c45ac298acbd2aa02e86049692b71fe22b11a8018f4f432705542e'
        };
        for(const sitePath of result.sitePaths) {
          if(!sitePath.startsWith('/usr/'))return null;
          if(!existsSync(sitePath))continue;
          for(const name of readdirSync(sitePath).filter(name=>name.endsWith('.pth'))) {
            const file=join(sitePath,name),info=lstatSync(file);
            if(!info.isFile() || info.uid!==0 || info.mode & 0o022 || createHash('sha256').update(readFileSync(file)).digest('hex')!==pthAllowed[name])return null;
            paths.push(file);
          }
        }
        const digest=createHash('sha256'),visited=new Set();
        function visit(file) {
          digest.update(file).update('\0');
          if(!existsSync(file)){digest.update('missing\0');return;}
          const stat=lstatSync(file);if(stat.uid!==0 || (!stat.isSymbolicLink() && stat.mode & 0o022))throw Error('UNQUALIFIED_PYTHON_PATH');digest.update(String(stat.mode)).update('\0');
          if(stat.isSymbolicLink()) {
            digest.update(readlinkSync(file)).update('\0');
            const target=realpathSync(file);if(!target.startsWith('/usr/') && !target.startsWith('/etc/python3.12/'))throw Error('UNQUALIFIED_PYTHON_PATH');
            if(!visited.has(target))visit(target);
          } else if(stat.isDirectory()) {
            const real=realpathSync(file);if(!real.startsWith('/usr/'))throw Error('UNQUALIFIED_PYTHON_PATH');
            if(visited.has(real))return;visited.add(real);
            for(const name of readdirSync(file).sort())visit(join(file,name));
          } else if(stat.isFile())digest.update(readFileSync(file));
          else throw Error('UNQUALIFIED_PYTHON_PATH');
        }
        for(const entry of paths) {if(!entry.startsWith('/usr/'))return null;visit(entry);}
        const closure={name:'python-path',sha256:digest.digest('hex')};toolCache.set(cacheName,closure);tools.push(closure);
      }
    } catch {return null;}
  }
  const environment=Object.entries(process.env).filter(([key])=>key!=='CODEX_TOOL_CALL_ID').sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({checks:item.checks,tools,environment,node:process.execPath,nodeVersion:process.version,uid:process.getuid?.(),gid:process.getgid?.(),groups:process.getgroups?.()})).digest('hex');
}
export async function execute(root, action, ids=[], {base,includeDependencies=true}={}) {
  const toolCache=new Map(),dependencyCache=new Map();
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
    let checked=false, checkProof, checkGroups, checkDependencies;
    if (['check','run'].includes(action)) {
      const dependencies=dependencyInventory(root,c,true,dependencyCache);checkDependencies=dependencies;
      // Only explicit checker contracts can reuse a result. Persist no environment values.
      if(c.commands.checkGroups) {
        const groups=c.commands.checkGroups, ids=new Set(groups.map(g=>g.id));
        if(ids.size!==groups.length)throw Error(`CHECK_GROUP_DUPLICATE: ${c.id}`);
        const receipts={...state.checkGroups},inputs=[];let executed=false;
        checkGroups=[];
        for(const group of groups) {
          const checks=checkGroupFingerprint(root,c,group), qualified={...c,commands:{...c.commands,checkTools:group.tools,pythonModules:group.pythonModules,pythonAbsent:group.pythonAbsent,absentPaths:group.absentPaths}};
          const key=dependencies && checkKey(qualified,{checks:checks+dependencies},toolCache);
          const proof=key && receipts[group.id]===key?'cached':'executed';
          if(proof==='executed') {command(root,c,group.command);executed=true;}
          if(checkGroupFingerprint(root,c,group)!==checks || (key && checkKey(qualified,{checks:checks+dependencies},toolCache)!==key))throw Error(`CHECK_INPUTS_CHANGED: ${c.id}`);
          inputs.push({group,checks});receipts[group.id]=key;checkGroups.push({id:group.id,proof});
        }
        if(inputs.some(({group,checks})=>checkGroupFingerprint(root,c,group)!==checks))throw Error(`CHECK_INPUTS_CHANGED: ${c.id}`);
        if(dependencies && dependencyInventory(root,c,true,new Map())!==dependencies)throw Error(`CHECK_DEPENDENCIES_CHANGED: ${c.id}`);
        state.checkGroups=receipts;
        checkProof=executed?'executed':'cached';
      } else {
        const key=dependencies && checkKey(c,{checks:item.checks+dependencies},toolCache);
        if(key && state.checkReceipt?.key===key) checkProof='cached';
        else {command(root,c,c.commands.check);checkProof='executed';}
        if(fingerprints(root,c).checks!==item.checks || (key && checkKey(c,{checks:item.checks+dependencies},toolCache)!==key))throw Error(`CHECK_INPUTS_CHANGED: ${c.id}`);
        if(dependencies && dependencyInventory(root,c,true,new Map())!==dependencies)throw Error(`CHECK_DEPENDENCIES_CHANGED: ${c.id}`);
        state.checkReceipt=key?{key}:null;
      }
      verifyBuildReceipt(root,c,state,item.build);checked=true;
      state.checks=item.checks;saveState(statePath,state);
    }
    let artifact,packaged=false;
    if (['package','run'].includes(action)) {
      const {packageComponent,verifyPackage}=await import('./package-runtime.mjs');
      const delivery={...c.delivery,files:[...new Set([...c.delivery.files,...c.dependencies.flatMap(d=>d.delivery)])]};
      // Standalone packages use only the verified Next output, already included in item.runtime.
      const dependencies=c.delivery.strategy==='next-standalone'?'next-standalone-output':dependencyInventory(root,c,false,dependencyCache);
      if(dependencies && state.runtimeDependencies===dependencies && state.runtime===item.runtime && state.packagePath && existsSync(state.packagePath)) artifact=verifyPackage(state.packagePath,c.id);
      else {artifact=await packageComponent(root,{...c,delivery},join(root,'tmp','component-packages'));packaged=true;}
      if(dependencies && c.delivery.strategy!=='next-standalone' && dependencyInventory(root,c,false,new Map())!==dependencies)throw Error(`PACKAGE_DEPENDENCIES_CHANGED: ${c.id}`);
      if(c.delivery.strategy==='next-standalone' && fingerprints(root,c).runtime!==item.runtime)throw Error(`PACKAGE_INPUTS_CHANGED: ${c.id}`);
      if(checkDependencies && dependencyInventory(root,c,true,new Map())!==checkDependencies)throw Error(`CHECK_DEPENDENCIES_CHANGED: ${c.id}`);
      state.runtime=item.runtime;state.runtimeDependencies=dependencies;state.packagePath=artifact.path;saveState(statePath,state);
    }
    results.push({id:item.id,compiled,checked,checkProof,checkGroups,packaged,...item,artifact});
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
