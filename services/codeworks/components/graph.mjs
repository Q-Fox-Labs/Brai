// ABOUTME: Discovers owner descriptors, checks build edges and compares component lifecycle with Git.
// ABOUTME: Git задаёт границу исходников; ignored live-каталоги не читаются.
import { existsSync, globSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { descriptorValidator } from './descriptor-validation.mjs';
import { lockInputs } from './lock-inputs.mjs';

const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'tmp', '__pycache__', '.venv']);
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
/** Возвращает существующие tracked и новые non-ignored исходники без обхода live-каталогов. */
export function sourceFiles(root) {
  const paths = git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
  return [...new Set(paths)].filter(path => {
    if (path.split('/').some(part=>ignored.has(part)) || !existsSync(join(root,path))) return false;
    return lstatSync(join(root,path)).isFile();
  }).sort();
}
export function expand(root, patterns) {
  const paths = new Set();
  for (const pattern of patterns) {
    const matches = existsSync(join(root,pattern)) ? [pattern] : globSync(pattern, {cwd:root, exclude: path => path.split('/').some(part => ignored.has(part))});
    if (!matches.length) throw Error(`INPUT_NOT_FOUND: ${pattern}`);
    for (const path of matches) {
      const stat = lstatSync(join(root,path));
      if (stat.isSymbolicLink()) throw Error(`INPUT_SYMLINK: ${path}`);
      if (stat.isFile()) paths.add(path);
    }
  }
  return [...paths].sort();
}
export function digestFiles(root, paths, metadata = {}) {
  const hash = createHash('sha256').update(JSON.stringify(metadata));
  for (const path of [...new Set(paths)].sort()) hash.update(path).update('\0').update(readFileSync(join(root,path))).update('\0');
  return hash.digest('hex');
}
function git(root, args) { return execFileSync('git', ['-C',root,...args], {encoding:'utf8',maxBuffer:32*1024*1024}); }
export function discover(root, {base, allowMissingBuildOutputs = false} = {}) {
  const files = sourceFiles(root);
  const validator = descriptorValidator(json(join(root,'services/codeworks/schemas/component.schema.json')));
  const components = new Map();
  for (const file of files.filter(path => path.endsWith('/component.json') || path === 'component.json')) {
    const value = json(join(root,file));
    if (!validator(value)) throw Error(`COMPONENT_SCHEMA: ${file}: ${JSON.stringify(validator.errors)}`);
    if (components.has(value.id)) throw Error(`DUPLICATE_COMPONENT: ${value.id}`);
    components.set(value.id, {...value,directory:dirname(file),descriptor:file});
  }
  if (base) {
    // A tombstone is retained under version control; disappearing descriptions never silently stop deployed units.
    const before=git(root,['ls-tree','-r','--name-only',base]).trim().split('\n').filter(p=>p.endsWith('/component.json'));
    for (const path of before) {
      const old=JSON.parse(git(root,['show',`${base}:${path}`]));
      const current=components.get(old.id);
      if (!current) throw Error(`COMPONENT_REMOVED_WITHOUT_RETIREMENT: ${old.id}`);
      if (old.status==='retired' && current.status!=='retired') throw Error(`RETIRED_ID_REUSED: ${old.id}`);
      if (old.status==='active' && current.status==='active' && old.deploy.units.some(unit=>!current.deploy.units.includes(unit))) throw Error(`DEPLOY_UNIT_REMOVED_WITHOUT_RETIREMENT: ${old.id}`);
    }
  }
  const active = [...components.values()].filter(c=>c.status==='active');
  const owner = path => active.filter(c => path===c.directory || path.startsWith(c.directory+'/')).sort((a,b)=>b.directory.length-a.directory.length)[0];
  for (const file of files) {
    if ((file==='package.json' || file.endsWith('/package.json')) && !active.some(c=>c.directory===dirname(file))) {
      const manifest=json(join(root,file));
      if(manifest.bin || Object.keys(manifest.scripts??{}).some(name=>/^(start($|:)|mcp$|migrate$|health$|trusted$)/.test(name))) throw Error(`MISSING_COMPONENT: ${file}`);
    }
    if (/^(apps|services)\/[^/]+\/package\.json$/.test(file) && !active.some(c=>c.directory===dirname(file))) throw Error(`MISSING_COMPONENT: ${file}`);
    // New executable entrypoints must be explicitly admitted by their owner, including nested Python programs.
    const executable = (lstatSync(join(root,file)).mode & 0o111) && readFileSync(join(root,file),'utf8').startsWith('#!');
    if ((executable || /(^|\/)(main\.(ts|mjs|js|py)|runner\.py)$/.test(file)) && !file.includes('/tests/') && !file.includes('/test/')) {
      if (!owner(file)?.executableSources.includes(file)) throw Error(`MISSING_EXECUTABLE: ${file}`);
    }
    if (/(^|\/)Dockerfile$/.test(file) && /^(apps|services|dependencies)\//.test(file) && !owner(file)) throw Error(`MISSING_COMPONENT: ${file}`);
  }
  for (const c of components.values()) {
    if (c.renamedTo && (!components.has(c.renamedTo) || c.status!=='retired' || components.get(c.renamedTo).status!=='active')) throw Error(`INVALID_RENAME: ${c.id}`);
    if (c.status!=='active') continue;
    expand(root, [...c.inputs.build,...c.inputs.runtime,...c.inputs.checks]);
    for (const path of [...c.delivery.files,...c.dependencies.flatMap(d=>d.delivery)]) {
      const generated = allowMissingBuildOutputs && owner(path)?.commands.build && /\/(?:dist|\.next)(?:\/|$)/.test(path);
      if (!existsSync(join(root,path)) && !generated) throw Error(`DELIVERY_NOT_FOUND: ${c.id}: ${path}`);
    }
    for (const source of c.executableSources) if (!existsSync(join(root,source))) throw Error(`EXECUTABLE_NOT_FOUND: ${source}`);
    const deps = new Set();
    for (const dep of c.dependencies) {
      if (deps.has(dep.id)) throw Error(`DUPLICATE_DEPENDENCY: ${c.id} -> ${dep.id}`);
      deps.add(dep.id);
      if (!components.has(dep.id) || components.get(dep.id).status!=='active') throw Error(`UNKNOWN_DEPENDENCY: ${c.id} -> ${dep.id}`);
      expand(root,dep.inputs);
    }
    for (const workspace of c.npm.workspaces) if (!existsSync(join(root,workspace,'package.json'))) throw Error(`WORKSPACE_NOT_FOUND: ${workspace}`);
    const packageFile=join(root,c.directory,'package.json');
    if(existsSync(packageFile)) {
      const manifest=json(packageFile), bins=typeof manifest.bin==='string'?[manifest.bin]:Object.values(manifest.bin??{});
      const admit=(entry,kind)=>{
        const path=posix.normalize(posix.join(c.directory,entry));
        if(!c.delivery.entrypoints.includes(path)) throw Error(`UNDECLARED_EXECUTABLE_${kind}: ${c.id}: ${entry}`);
      };
      for(const entry of bins) admit(entry,'BIN');
      for(const [name,text] of Object.entries(manifest.scripts??{})) {
        if(!/^(start($|:)|mcp$|migrate$|health$|trusted$)/.test(name)) continue;
        // Tokenize the usual quoted shell arguments without executing the script. Runtime flags may precede its entrypoint.
        const tokens=(String(text).match(/"[^"]*"|'[^']*'|[^\s;&|]+/g)??[]).map(token=>token.replace(/^(['"])(.*)\1$/,'$2'));
        const valueFlags=new Set(['-r','--require','--import','--loader','--experimental-loader','-C','--conditions','--title','--icu-data-dir','--inspect-port','--input-type']);
        for(let i=0;i<tokens.length;i++) if(/(?:^|\/)(?:node(?:js)?|python(?:3(?:\.\d+)?)?)$/.test(tokens[i])) {
          for(let j=i+1;j<tokens.length;j++) {
            const token=tokens[j];
            if(['-e','--eval','-p','--print','-m','-c'].includes(token)) break;
            if(valueFlags.has(token)){j++;continue;}
            if(token.startsWith('-'))continue;
            if(/\.(?:[cm]?js|[cm]?ts|py)$/.test(token))admit(token,'SCRIPT');
            break;
          }
        }
      }
    }
  }
  const order = [], visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Error(`COMPONENT_CYCLE: ${[...visiting,id].join(' -> ')}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dep of components.get(id).dependencies) visit(dep.id);
    visiting.delete(id); done.add(id); order.push(id);
  }
  for (const c of active) visit(c.id);
  // Literal imports are checked as actual files, so a direct neighbor import cannot hide behind a broad graph edge.
  for (const c of active) {
    const admitted = new Set(c.dependencies.flatMap(d=>expand(root,d.inputs)));
    const localInputs = new Set(expand(root,[...c.inputs.runtime,...c.inputs.build]));
    for (const file of expand(root,c.inputs.runtime).filter(f=>/\.(mjs|js|ts|tsx)$/.test(f))) {
      const source = readFileSync(join(root,file),'utf8');
      const specifiers = [...source.matchAll(/(?:from\s*|import\s*\(|import\s*|new URL\s*\()(['"])([^'"\n]+)\1/g)].map(m=>m[2]);
      for (const specifier of specifiers) {
        let target;
        if (specifier.startsWith('.')) {
          const candidate = posix.normalize(posix.join(dirname(file),specifier));
          target = [candidate.replace('/dist/','/src/').replace(/\.js$/,'.ts'),candidate,candidate.replace(/\.js$/,'.ts'),candidate.replace(/\.mjs$/,'.mts')].find(p=>existsSync(join(root,p)) && lstatSync(join(root,p)).isFile());
        } else if (specifier.startsWith('@brai/')) {
          const parts=specifier.split('/'), name=parts.slice(0,2).join('/');
          const dependency=active.find(other=>existsSync(join(root,other.directory,'package.json')) && json(join(root,other.directory,'package.json')).name===name);
          if (dependency && dependency.id!==c.id && !c.dependencies.some(d=>d.id===dependency.id)) throw Error(`UNDECLARED_IMPORT: ${file} -> ${specifier}`);
        }
        if (target) {
          const other=owner(target);
          if (other?.id===c.id && !localInputs.has(target)) throw Error(`UNDECLARED_LOCAL_INPUT: ${file} -> ${target}`);
          if (other && other.id!==c.id && !admitted.has(target)) throw Error(`UNDECLARED_IMPORT: ${file} -> ${target}`);
        }
      }
    }
  }
  return {components, order,files};
}
export function fingerprints(root, component, {platform=`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,variant=process.env.BRAI_WEB_VARIANT??'production'}={}) {
  const c=component;
  const deps=c.dependencies.flatMap(d=>expand(root,d.inputs));
  const buildFiles=expand(root,[...c.inputs.build,...c.inputs.runtime].filter(path=>path!=='package-lock.json'));
  const target={platform:platform.split('/')[0],arch:platform.split('/')[1]==='amd64'?'x64':platform.split('/')[1]};
  const runtimeLock=lockInputs(root,c.npm.workspaces,target);
  const buildLock=c.commands.build?lockInputs(root,c.npm.workspaces,{...target,development:true}):runtimeLock;
  const checkLock=lockInputs(root,c.npm.workspaces,{...target,development:true});
  const toolchainPath=join(root,'services/codeworks/ci/toolchain.json');
  const toolchain=existsSync(toolchainPath)?json(toolchainPath):{node:process.versions.node,npm:'11.19.1',nodeBase:'node:24.22.1-bookworm-slim'};
  const compatibility={platform,libc:target.platform==='linux'?(process.report.getReport().header.glibcVersionRuntime?'glibc':'musl'):null,node:toolchain.node,npm:toolchain.npm,...(c.id==='web'?{variant,standalone:false}:{})};
  const buildEngine=digestFiles(dirname(fileURLToPath(import.meta.url)),['graph.mjs','cli.mjs','lock-inputs.mjs']);
  const build=digestFiles(root,[...buildFiles,...deps],{formatVersion:c.formatVersion,build:c.commands.build,lock:buildLock,compatibility,buildEngine,outputs:c.delivery.files.filter(path=>/\/(?:dist|\.next)(?:\/|$)/.test(path))});
  const packagingEngine=digestFiles(dirname(fileURLToPath(import.meta.url)),['package-runtime.mjs','lock-inputs.mjs']);
  const deliveryFiles=[...new Set([...c.delivery.files,...c.dependencies.flatMap(d=>d.delivery)])].sort();
  const payloadInputs=[];
  function collect(path) {
    if(!existsSync(join(root,path)))return; // A first build may not have produced its generated output yet.
    const stat=lstatSync(join(root,path));
    if(stat.isSymbolicLink())throw Error(`INPUT_SYMLINK: ${path}`);
    if(stat.isDirectory())for(const name of readdirSync(join(root,path)).sort())collect(posix.join(path,name));
    else if(stat.isFile())payloadInputs.push(path);
  }
  deliveryFiles.forEach(collect);
  const delivery={...c.delivery,files:deliveryFiles};
  const sourcePayload=payloadInputs.filter(path=>!/\/(?:dist|\.next)(?:\/|$)/.test(path));
  const artifact=digestFiles(root,[...expand(root,c.inputs.runtime),...deps,...sourcePayload],{build,delivery,npm:runtimeLock,packagingEngine,compatibility,sourceModes:sourcePayload.map(path=>[path,lstatSync(join(root,path)).mode & 0o777]),base:c.delivery.kind==='oci-context'?toolchain.nodeBase:null,recipe:c.id==='instaloader'?toolchain.pythonBase:null});
  const runtime=digestFiles(root,payloadInputs,{artifact,modes:payloadInputs.map(path=>[path,lstatSync(join(root,path)).mode & 0o777])});
  const checks=digestFiles(root,[...buildFiles,...deps,...expand(root,c.inputs.checks)],{build,check:c.commands.check,lock:checkLock,delivery});
  return {build,runtime,checks,artifact,compatibility};
}
