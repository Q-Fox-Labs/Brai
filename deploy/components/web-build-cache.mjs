// ABOUTME: Проверяет фактические зависимости и переносит webpack cache отдельными inode.
// ABOUTME: Shared cache остаётся подсказкой компилятора; публикация следует успешной проверке.
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,closeSync,constants,cpSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifySources} from './source-snapshot.mjs';

const shared='/srv/projects/brai-dev/apps/web/.next/cache/.brai-release';
const self=fileURLToPath(import.meta.url),inside=(root,path)=>path===root||path.startsWith(root+sep);
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const metadata=cache=>join(cache,'.brai-source-snapshot.json');
function cacheMetadata(cache) {
  const fd=openSync(metadata(cache),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=fstatSync(fd);
    if(!info.isFile() || info.nlink!==1 || (info.mode&0o777)!==0o600)throw Error('WEB_CACHE_METADATA_INVALID');
    return JSON.parse(readFileSync(fd,'utf8'));
  } finally {closeSync(fd);}
}

function tree(hash,path,logical,allowed,ancestors=new Set(),protectedFiles=false) {
  const real=realpathSync(path),info=statSync(real);
  if(!allowed.some(root=>inside(root,real)) || (protectedFiles && (info.uid!==0 || info.mode&0o022)))throw Error('UNQUALIFIED_CACHE_INPUT');
  hash.update(JSON.stringify([logical,info.mode&0o777,info.isDirectory()?'d':'f'])).update('\0');
  if(info.isDirectory()) {
    if(ancestors.has(real))throw Error('CACHE_INPUT_CYCLE');
    const next=new Set(ancestors).add(real);
    for(const name of readdirSync(real).sort()) {
      if(name==='node_modules' && !protectedFiles)continue;
      if(/^\.env(?:\.|$)/i.test(name)||name==='.git'||name==='usercustom'||name==='tmp')throw Error('UNQUALIFIED_CACHE_INPUT');
      tree(hash,join(real,name),logical+'/'+name,allowed,next,protectedFiles);
    }
  } else if(info.isFile()) {
    const fd=openSync(real,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const opened=fstatSync(fd);
      if(opened.dev!==info.dev || opened.ino!==info.ino || opened.size!==info.size || (opened.mode&0o777)!==(info.mode&0o777))throw Error('WEB_CACHE_CHANGED');
      hash.update(String(opened.size)).update('\0');
      const bytes=Buffer.allocUnsafe(1024*1024);let count;
      while((count=readSync(fd,bytes,0,bytes.length,null))!==0)hash.update(bytes.subarray(0,count));
      if(fstatSync(fd).size!==opened.size)throw Error('WEB_CACHE_CHANGED');
      hash.update('\0');
    } finally {closeSync(fd);}
  }
  else throw Error('UNQUALIFIED_CACHE_INPUT');
}

function proofSchema(value) {
  const fields=['arch','contentSha256','format','lockSha256','node','npm','platform','relativeRoots','root','toolchainSha256'];
  return value && JSON.stringify(Object.keys(value).sort())===JSON.stringify(fields) && value.format==='brai-dev-dependency-generation-v1' &&
    value.platform==='linux' && value.arch==='x64' && ['contentSha256','lockSha256','toolchainSha256'].every(key=>/^[a-f0-9]{64}$/.test(value[key]??'')) &&
    value.root===`/opt/brai-shared/immutable-files-v1/npm-${value.contentSha256}` && /^\d+\.\d+\.\d+$/.test(value.node??'') && /^\d+\.\d+\.\d+$/.test(value.npm??'') &&
    Array.isArray(value.relativeRoots) && value.relativeRoots.includes('node_modules') && new Set(value.relativeRoots).size===value.relativeRoots.length &&
    value.relativeRoots.every(path=>/^(?:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/)?node_modules$/.test(path));
}
function protectedAncestors(path) {
  let current=path;
  for(;;) {
    const info=lstatSync(current);
    if(info.isSymbolicLink() || info.uid!==0 || info.gid!==0 || info.mode&0o022)return false;
    const parent=dirname(current);if(parent===current)return true;current=parent;
  }
}
function readonlyMounts(paths) {
  const mounts=readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' - ')[0].split(' '));
  return paths.every(path=>mounts.some(fields=>fields[4]===path && fields[5]?.split(',').includes('ro')));
}
function hostProof() {
  const owner='/usr/local/libexec/brai-dev-release/prepared_dependencies.py';
  if(!existsSync(owner) || !protectedAncestors(owner))return null;
  const result=spawnSync('/usr/bin/python3',['-B',owner,'verify'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  if(result.status!==0)return null;
  const proof=JSON.parse(result.stdout);
  return proofSchema(proof) && protectedAncestors(proof.root)?proof:null;
}
export function trustedHostGeneration(path) {
  try {return hostProof()?.root===path;} catch {return false;}
}
function verifiedProof(root,roots) {
  if(process.env.BRAI_PUBLISHER_PROOF_FD==='3') {
    const info=fstatSync(3),fixed=statSync('/publisher-proof/receipt.json');
    const flags=readFileSync('/proc/self/fdinfo/3','utf8').match(/^flags:\s+([0-7]+)$/m);
    if(!info.isFile() || info.dev!==fixed.dev || info.ino!==fixed.ino || !flags || (parseInt(flags[1],8)&3)!==0)return null;
    const bytes=Buffer.alloc(info.size);if(readSync(3,bytes,0,bytes.length,0)!==bytes.length)return null;
    const proof=JSON.parse(bytes.toString('utf8')),job=dirname(root),prepared=join(job,'repo/.git/codeworks-dependencies/prepared');
    if(!proofSchema(proof) || !/^\/var\/lib\/brai-dev\/host-publisher\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/checkout$/.test(root) ||
       !roots.some(path=>realpathSync(path)===realpathSync(join(prepared,'node_modules'))) || !roots.every(path=>inside(prepared,realpathSync(path))) ||
       !readonlyMounts(['/publisher-proof/receipt.json',prepared,proof.root,'/usr/local/libexec/brai-dev-release/check-tools']) ||
       realpathSync(process.execPath)!=='/usr/local/libexec/brai-dev-release/check-tools/bin/node')return null;
    return proof;
  }
  const proof=hostProof();
  if(!proof || !roots.some(path=>realpathSync(path)===realpathSync(join(proof.root,'node_modules'))) || !roots.every(path=>inside(proof.root,realpathSync(path))) ||
     realpathSync(process.execPath)!==realpathSync(join(proof.root,'.brai-check-tools/bin/node')))return null;
  return proof;
}
/** null запрещает перенос кеша без Root-verified immutable closure. */
export function cacheIdentity(root,component,dependencyRoots) {
  try {
    if(process.env.NODE_PATH||process.env.NODE_OPTIONS||Object.entries(process.env).some(([key,value])=>key.startsWith('LD_')&&value))return null;
    const proof=verifiedProof(root,dependencyRoots);if(!proof)return null;
    const toolchainFile=join(proof.root,'.brai-toolchain.json'),toolchain=json(toolchainFile);
    if(hashFile(toolchainFile)!==proof.toolchainSha256 || toolchain.nodeAbi!==process.versions.modules ||
       toolchain.glibc!==`glibc ${process.report.getReport().header.glibcVersionRuntime}` || process.versions.node!==proof.node)return null;
    const hash=createHash('sha256');
    for(const path of [self,join(dirname(self),'source-snapshot.mjs'),join(dirname(self),'build-web-standalone.mjs'),join(dirname(self),'lock-inputs.mjs'),join(dirname(self),'graph.mjs')])hash.update(readFileSync(path));
    for(const path of ['package.json','apps/web/package.json','apps/web/next.config.ts','apps/web/tsconfig.json','apps/web/postcss.config.mjs'])hash.update(path).update('\0').update(readFileSync(join(root,path))).update('\0');
    hash.update(JSON.stringify({content:proof.contentSha256,toolchain:proof.toolchainSha256,build:component.commands?.build,workspaces:component.npm?.workspaces,variant:process.env.BRAI_WEB_VARIANT??'production',node:process.version,umask:process.umask()}));
    return hash.digest('hex');
  } catch {return null;}
}

function cacheDigest(cache) {
  const hash=createHash('sha256'),webpack=join(cache,'webpack');
  if(!existsSync(webpack))throw Error('WEB_CACHE_MISSING');
  if(lstatSync(webpack).isSymbolicLink() || !lstatSync(webpack).isDirectory() || !inside(realpathSync(cache),realpathSync(webpack)))throw Error('WEB_CACHE_PATH_INVALID');
  tree(hash,webpack,'webpack',[realpathSync(webpack)]);return hash.digest('hex');
}
function copyTree(source,target) {cpSync(source,target,{recursive:true,mode:constants.COPYFILE_FICLONE});}
export function cacheOperation(kind,local,identity,store=shared) {
  if(!/^[a-f0-9]{64}$/.test(identity))throw Error('WEB_CACHE_IDENTITY_INVALID');
  const namespace=join(store,identity),snapshot=join(namespace,'snapshot');
  if(lstatSync(namespace).isSymbolicLink() || !lstatSync(namespace).isDirectory() || !inside(realpathSync(store),realpathSync(namespace)))throw Error('WEB_CACHE_PATH_INVALID');
  if(existsSync(snapshot) && (lstatSync(snapshot).isSymbolicLink() || !lstatSync(snapshot).isDirectory() || !inside(realpathSync(namespace),realpathSync(snapshot))))throw Error('WEB_CACHE_PATH_INVALID');
  if(kind==='restore') {
    if(!existsSync(join(snapshot,'.brai-source-snapshot.json')))return;
    const data=cacheMetadata(snapshot);
    if(data.identity!==identity || data.cacheDigest!==cacheDigest(snapshot))return;
    rmSync(join(local,'webpack'),{recursive:true,force:true});copyTree(join(snapshot,'webpack'),join(local,'webpack'));
    if(cacheDigest(local)!==data.cacheDigest)throw Error('WEB_CACHE_COPY_CHANGED');
    writeFileSync(metadata(local),JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});chmodSync(metadata(local),0o600);
  } else if(kind==='publish') {
    const data=cacheMetadata(local);
    if(data.identity!==identity || data.cacheDigest!==cacheDigest(local))throw Error('WEB_CACHE_CHANGED');
    const temporary=join(namespace,'.snapshot-'+randomUUID()),old=join(namespace,'.previous-'+randomUUID());
    mkdirSync(temporary,{recursive:true});
    try {
      copyTree(join(local,'webpack'),join(temporary,'webpack'));
      if(cacheDigest(temporary)!==data.cacheDigest)throw Error('WEB_CACHE_COPY_CHANGED');
      writeFileSync(metadata(temporary),JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});chmodSync(metadata(temporary),0o600);
      if(existsSync(snapshot))renameSync(snapshot,old);
      try {renameSync(temporary,snapshot);} catch(error) {if(existsSync(old))renameSync(old,snapshot);throw error;}
      rmSync(old,{recursive:true,force:true});
    } finally {rmSync(temporary,{recursive:true,force:true});}
  } else throw Error('WEB_CACHE_OPERATION_INVALID');
}
function locked(kind,local,identity) {
  // Cache lock существует только на время копирования/публикации и не связан с DEV switch.
  if(!/^[a-f0-9]{64}$/.test(identity))throw Error('WEB_CACHE_IDENTITY_INVALID');
  mkdirSync(shared,{recursive:true,mode:0o700});
  const sharedInfo=lstatSync(shared);
  if(sharedInfo.isSymbolicLink() || !sharedInfo.isDirectory() || sharedInfo.uid!==process.getuid() || (sharedInfo.mode&0o777)!==0o700)throw Error('WEB_CACHE_PATH_INVALID');
  const namespace=join(shared,identity);mkdirSync(namespace,{recursive:true,mode:0o700});
  const info=lstatSync(namespace);
  if(info.isSymbolicLink() || !info.isDirectory() || info.uid!==process.getuid() || (info.mode&0o777)!==0o700)throw Error('WEB_CACHE_PATH_INVALID');
  const result=spawnSync('/usr/bin/flock',['-x',join(namespace,'.lock'),process.execPath,self,kind,local,identity],{stdio:'inherit'});
  if(result.error)throw result.error;if(result.status!==0)throw Error('WEB_CACHE_OPERATION_FAILED');
}
export function restoreWebCache(local,identity) {
  if(!identity)return null;
  mkdirSync(local,{recursive:true});
  try {const data=cacheMetadata(local);if(data.identity===identity && data.cacheDigest===cacheDigest(local))return data;} catch {}
  rmSync(metadata(local),{force:true});
  try {locked('restore',local,identity);} catch {return null;}
  try {const data=cacheMetadata(local);if(data.identity===identity)return data;} catch {}
  return null;
}
export function saveWebCacheMetadata(local,data) {
  if(!data.identity)return;
  try {data.cacheDigest=cacheDigest(local);} catch {return;}
  const temporary=metadata(local)+'.'+randomUUID();writeFileSync(temporary,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,metadata(local));
}
export function publishWebCache(root,component,dependencyRoots) {
  try {
    const local=join(root,'apps/web/.next/cache');
    if(!existsSync(metadata(local)))return false;
    const data=cacheMetadata(local),identity=cacheIdentity(root,component,dependencyRoots);
    if(!identity || data.identity!==identity || !verifySources(root,data.files))return false;
    locked('publish',local,identity);return true;
  } catch {return false;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [kind,local,identity]=process.argv.slice(2);cacheOperation(kind,local,identity);
}
