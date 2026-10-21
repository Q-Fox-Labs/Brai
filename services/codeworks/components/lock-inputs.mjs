// ABOUTME: Выбирает действительные npm lock entries без node_modules и сетевых запросов.
// ABOUTME: Build/check учитывают dev roots; runtime исключает dev и optional peers.
import {readFileSync} from 'node:fs';
import {join,posix,basename} from 'node:path';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b))));
function requests(from,entry,development=false) {
  const optional=entry.optionalDependencies??{};
  return [
    ...Object.keys({...entry.dependencies,...(development?entry.devDependencies:{})}).filter(name=>!(name in optional)).map(name=>({from,name,optional:false})),
    ...Object.keys(optional).map(name=>({from,name,optional:true})),
    ...Object.keys(entry.peerDependencies??{}).filter(name=>!entry.peerDependenciesMeta?.[name]?.optional).map(name=>({from,name,optional:false})),
  ];
}
function candidates(from,name) {
  if(!/^(?:@[^/]+\/)?[^/]+$/.test(name)||name.includes('..')||name.includes('\\'))throw Error('INVALID_DEPENDENCY_NAME');
  const paths=[];
  for(let cursor=from;cursor&&cursor!=='.';cursor=posix.dirname(cursor))if(basename(cursor)!=='node_modules')paths.push(`${cursor}/node_modules/${name}`);
  return [...new Set([...paths,`node_modules/${name}`])];
}
/** Возвращает сортированный lock closure для заданной платформы; installed state не влияет на ключ. */
export function lockInputs(root,workspaces,{development=false,platform=process.platform,arch=process.arch,libc=process.report.getReport().header.glibcVersionRuntime?'glibc':'musl'}={}) {
  if(!workspaces.length)return [];
  const lock=read(join(root,'package-lock.json'));
  if(!lock.packages||lock.lockfileVersion<2)throw Error('UNSUPPORTED_PACKAGE_LOCK');
  const selected=new Map(),visited=new Set(),pending=[];
  function workspace(key) {
    if(visited.has(key))return;
    if(key.startsWith('/')||key.split('/').includes('..'))throw Error('INVALID_WORKSPACE_PATH');
    const manifest=read(join(root,key,'package.json')),entry=lock.packages[key];
    if(!entry||entry.link)throw Error(`LOCK_WORKSPACE_ENTRY_MISSING: ${key}`);
    for(const field of ['dependencies','optionalDependencies','peerDependencies','peerDependenciesMeta',...(development?['devDependencies']:[])])if(canonical(manifest[field])!==canonical(entry[field]))throw Error(`WORKSPACE_LOCK_MISMATCH: ${key}: ${field}`);
    if(manifest.version!==entry.version||(entry.name&&manifest.name!==entry.name))throw Error(`WORKSPACE_LOCK_MISMATCH: ${key}: identity`);
    visited.add(key);
    const {devDependencies,...runtime}=entry;
    selected.set(key,development?entry:runtime);
    pending.push(...requests(key,manifest,development));
  }
  workspaces.forEach(workspace);
  const supports=(values,actual)=>!values||(!values.includes('!'+actual)&&(values.every(v=>v.startsWith('!'))||values.includes(actual)||values.includes('any')));
  while(pending.length) {
    const request=pending.pop(),key=candidates(request.from,request.name).find(key=>lock.packages[key]);
    if(!key){if(request.optional)continue;throw Error(`LOCK_ENTRY_MISSING: ${request.from} -> ${request.name}`);}
    if(selected.has(key))continue;
    const entry=lock.packages[key];
    if(!supports(entry.os,platform)||!supports(entry.cpu,arch)||(platform==='linux'&&!supports(entry.libc,libc))){if(request.optional)continue;throw Error(`UNSUPPORTED_PACKAGE_PLATFORM: ${key}`);}
    selected.set(key,entry);
    if(entry.link)workspace(entry.resolved);else pending.push(...requests(key,entry));
  }
  return [...selected].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,entry])=>({key,entry}));
}
