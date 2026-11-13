// ABOUTME: Сохраняет времена только для исходников с проверенными одинаковыми байтами.
// ABOUTME: Позволяет компилятору повторно использовать кеш в независимом /workspace.
import {createHash} from 'node:crypto';
import {constants,copyFileSync,lstatSync,mkdirSync,readFileSync,readdirSync,statSync,utimesSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sourceFiles} from './graph.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceDigest=(path,mode=lstatSync(path).mode&0o777)=>createHash('sha256').update(String(mode)).update('\0').update(readFileSync(path)).digest('hex');
const valid=row=>row && /^[a-f0-9]{64}$/.test(row.sha256??'') && Number.isFinite(row.mtimeMs) && row.mtimeMs>0;
function restoreTime(path,previous,sha256) {
  if(valid(previous) && previous.sha256===sha256)utimesSync(path,previous.mtimeMs/1000,previous.mtimeMs/1000);
  else if(valid(previous))utimesSync(path,(previous.mtimeMs-2000)/1000,(previous.mtimeMs-2000)/1000);
  return {sha256,mtimeMs:statSync(path).mtimeMs};
}
export function snapshotSources(root,stage,previous={}) {
  const files={};
  for(const file of sourceFiles(root)) {
    if(file.split('/').some(part=>/^\.env(?:\.|$)/i.test(part)) || file.startsWith('docs/user-agent/usercustom/'))throw Error(`WEB_SOURCE_SECRET: ${file}`);
    const source=join(root,file),target=join(stage,file);
    const info=lstatSync(source);
    if(info.isSymbolicLink())throw Error(`WEB_SOURCE_SYMLINK: ${file}`);
    mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target,constants.COPYFILE_FICLONE);
    const staged=sourceDigest(target,info.mode&0o777);
    if(sourceDigest(source)!==staged)throw Error(`WEB_SOURCE_CHANGED: ${file}`);
    files[file]=restoreTime(target,previous.files?.[file],staged);
  }
  return files;
}
export function snapshotDirectories(stage,previous={}) {
  const dirs={};
  function visit(relative) {
    const path=join(stage,relative),names=readdirSync(path).sort();
    for(const name of names) {
      if(['node_modules','.next'].includes(name))continue;
      const child=relative?`${relative}/${name}`:name;
      if(lstatSync(join(stage,child)).isDirectory())visit(child);
    }
    const entries=names.map(name=>{const info=lstatSync(join(path,name));return [name,info.mode&0o777,info.isDirectory()?'d':info.isSymbolicLink()?'l':info.isFile()?'f':'other'];});
    dirs[relative]=restoreTime(path,previous.dirs?.[relative],digest(JSON.stringify(entries)));
  }
  visit('');return dirs;
}
export function verifySources(root,files) {
  const names=sourceFiles(root);
  return names.length===Object.keys(files).length && names.every(file=>valid(files[file]) && sourceDigest(join(root,file))===files[file].sha256);
}
