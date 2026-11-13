// ABOUTME: Собирает Next standalone в закрытом staging namespace с подготовленными npm-зависимостями.
// ABOUTME: Не устанавливает пакеты и не предоставляет сборке доступ к источникам хоста.
import {execFileSync,spawnSync} from 'node:child_process';
import {constants,cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync,chmodSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {lockInputs} from './lock-inputs.mjs';
import {snapshotSources,snapshotDirectories,verifySources} from './source-snapshot.mjs';
import {cacheIdentity,restoreWebCache,saveWebCacheMetadata,trustedHostGeneration} from './web-build-cache.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const inside=(parent,path)=>path===parent||path.startsWith(parent+sep);
const fail=message=>{throw Error(message);};
const json=path=>JSON.parse(readFileSync(path,'utf8'));

/** Проверяет containment каждой трассы Next до копирования результата. */
export function validateTraces(stage,nextRoot) {
  let traces=0;
  function visit(path) {
    const info=lstatSync(path);
    if(info.isSymbolicLink())fail(`WEB_TRACE_SYMLINK: ${path}`);
    if(info.isDirectory()) {
      if(path===join(nextRoot,'standalone') || path===join(nextRoot,'cache'))return;
      for(const name of readdirSync(path).sort())visit(join(path,name));
    } else if(path.endsWith('.nft.json')) {
      traces++;
      const trace=json(path);
      if(!Array.isArray(trace.files))fail(`WEB_TRACE_INVALID: ${path}`);
      for(const entry of trace.files) {
        if(typeof entry!=='string')fail(`WEB_TRACE_INVALID: ${path}`);
        const absolute=resolve(dirname(path),entry);
        if(!inside(stage,absolute) || !existsSync(absolute) || !inside(stage,realpathSync(absolute)))fail(`WEB_TRACE_ESCAPE: ${entry}`);
      }
    }
  }
  visit(nextRoot);if(!traces)fail('WEB_TRACE_MISSING');
}

/** Не допускает ссылки, специальные файлы и секреты в готовую поставку. */
export function validateStandalone(directory) {
  function visit(path) {
    const info=lstatSync(path), name=path.slice(directory.length+1), parts=name.split(sep);
    if(parts.some(part=>/^\.env(?:\.|$)/i.test(part)||part==='.git'||part==='usercustom') || /\.(?:key|pem|p12|pfx)$/i.test(name))fail(`WEB_OUTPUT_SECRET: ${name}`);
    if(info.isSymbolicLink())fail(`WEB_OUTPUT_SYMLINK: ${name}`);
    if(info.isDirectory())for(const child of readdirSync(path).sort())visit(join(path,child));
    else if(!info.isFile())fail(`WEB_OUTPUT_UNSUPPORTED: ${name}`);
  }
  visit(directory);
}

export function dependencyLocation(sourceRoot,key,bases,allowedRoots) {
  const source=realpathSync(join(sourceRoot,key));
  if(!allowedRoots.some(base=>inside(base,source)) || !bases.some(base=>existsSync(join(base,key)) && realpathSync(join(base,key))===source) || !statSync(source).isDirectory())fail(`WEB_DEPENDENCY_LINK_INVALID: ${key}`);
  return source;
}

export function dependencyRoots(sourceRoot=root) {
  const markerPath=join(sourceRoot,'node_modules/.brai-worktree.json');
  if(!existsSync(markerPath))return [sourceRoot];
  const marker=json(markerPath);
  const common=realpathSync(execFileSync('git',['-C',sourceRoot,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());
  const source=realpathSync(marker.source),expected=realpathSync(dirname(common));
  if(source!==expected)fail('WEB_DEPENDENCY_SOURCE_INVALID');
  const generation=marker.dependencyRoot?realpathSync(marker.dependencyRoot):source;
  if(generation!==source && !inside(join(common,'codeworks-dependencies'),generation) && !trustedHostGeneration(generation))fail('WEB_DEPENDENCY_ROOT_INVALID');
  return [generation];
}

function build() {
  const component=json(join(root,'apps/web/component.json'));
  const tmp=join(root,'tmp');mkdirSync(tmp,{recursive:true});
  const holder=mkdtempSync(join(tmp,'web-standalone-')),stage=join(holder,'source');mkdirSync(stage);
  try {
    const bases=dependencyRoots(),allowedRoots=bases.flatMap(base=>['node_modules','apps/web/node_modules','services/agent/node_modules'].map(path=>join(base,path))).filter(existsSync).map(path=>realpathSync(path));
    const cache=join(root,'apps/web/.next/cache'),stageCache=join(stage,'apps/web/.next/cache');
    mkdirSync(cache,{recursive:true});
    if(!inside(root,realpathSync(cache)))fail('WEB_CACHE_ESCAPE');
    const identity=cacheIdentity(root,component,allowedRoots),previous=restoreWebCache(cache,identity);
    rmSync(join(cache,'.brai-source-snapshot.json'),{force:true});
    if(!previous)rmSync(join(cache,'webpack'),{recursive:true,force:true});
    const files=snapshotSources(root,stage,previous??{});
    const entries=lockInputs(root,component.npm.workspaces,{development:true});
    const mounts=[];
    for(const {key,entry} of entries.filter(row=>row.key.split('/').includes('node_modules')).sort((a,b)=>a.key.split('/').length-b.key.split('/').length)) {
      const target=join(stage,key);mkdirSync(dirname(target),{recursive:true});
      if(entry.link) {
        const expected=realpathSync(join(root,entry.resolved));
        if(realpathSync(join(root,key))!==expected || !inside(root,expected))fail(`WEB_WORKSPACE_LINK_INVALID: ${key}`);
        symlinkSync(relative(dirname(target),join(stage,entry.resolved)),target);
      } else {
        const source=dependencyLocation(root,key,bases,allowedRoots);
        mkdirSync(target,{recursive:true});mounts.push('--ro-bind',source,`/workspace/${key}`);
      }
    }
    const bin=join(stage,'node_modules/.bin');mkdirSync(bin,{recursive:true});
    const node='/usr/local/libexec/brai-dev-release/check-tools/bin/node';
    const toolRoot=dirname(dirname(realpathSync(process.execPath)));
    const toolOverlay=toolRoot.startsWith('/opt/brai-shared/immutable-files-v1/npm-')?['--ro-bind',toolRoot,'/usr/local/libexec/brai-dev-release/check-tools']:[];
    const wrapper=join(bin,'next');writeFileSync(wrapper,`#!/bin/sh\nexec '${node}' /workspace/node_modules/next/dist/bin/next "$1" --webpack\n`,{mode:0o755});chmodSync(wrapper,0o755);
    mkdirSync(stageCache,{recursive:true});
    const dirs=snapshotDirectories(stage,previous??{});
    const args=['--tmpfs','/','--dir','/workspace','--ro-bind','/usr','/usr',...toolOverlay,'--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',stage,'/workspace',...mounts,'--bind',cache,'/workspace/apps/web/.next/cache','--unshare-net','--chdir','/workspace','--clearenv','--setenv','PATH','/usr/local/libexec/brai-dev-release/check-tools/bin:/usr/local/bin:/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','CI','1','--setenv','NEXT_TELEMETRY_DISABLED','1','--setenv','BRAI_WEB_STANDALONE_OUTPUT','1','--setenv','LANG','C.UTF-8'];
    if(process.env.BRAI_WEB_VARIANT)args.push('--setenv','BRAI_WEB_VARIANT',process.env.BRAI_WEB_VARIANT);
    const result=spawnSync('/usr/bin/bwrap',[...args,'--','/usr/local/libexec/brai-dev-release/check-tools/bin/npm','run','build','--workspace=@brai/web'],{stdio:'inherit'});
    if(result.error)throw result.error;if(result.status!==0)fail(`WEB_STANDALONE_BUILD_FAILED: ${result.status}`);
    const validation=spawnSync('/usr/bin/bwrap',[...args,'--',node,'/workspace/deploy/components/build-web-standalone.mjs','--validate-stage'],{stdio:'inherit'});
    if(validation.error)throw validation.error;if(validation.status!==0)fail(`WEB_STANDALONE_TRACE_FAILED: ${validation.status}`);
    const next=join(stage,'apps/web/.next'),output=join(next,'standalone');
    validateStandalone(output);
    if(!existsSync(join(output,'apps/web/server.js')))fail('WEB_STANDALONE_ENTRY_MISSING');
    if(!verifySources(root,files) || (identity && cacheIdentity(root,component,allowedRoots)!==identity))fail('WEB_BUILD_INPUTS_CHANGED');
    if(identity)saveWebCacheMetadata(cache,{identity,files,dirs});
    const destination=join(root,'apps/web/.next');mkdirSync(destination,{recursive:true});
    for(const name of ['standalone','static']) {
      const temporary=join(destination,`.${name}-${Date.now()}-${process.pid}`),target=join(destination,name),backup=temporary+'-previous';
      cpSync(join(next,name),temporary,{recursive:true,mode:constants.COPYFILE_FICLONE});
      if(existsSync(target))renameSync(target,backup);
      try {renameSync(temporary,target);} catch(error) {if(existsSync(backup))renameSync(backup,target);throw error;}
      rmSync(backup,{recursive:true,force:true});
    }
  } finally {rmSync(holder,{recursive:true,force:true});}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.argv[2]==='--validate-stage')validateTraces('/workspace','/workspace/apps/web/.next');
    else build();
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
