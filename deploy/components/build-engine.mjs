// ABOUTME: Fingerprints and verifies component build inputs and prepared outputs.
// ABOUTME: Check orchestration is deliberately outside the build identity.
import {existsSync, readFileSync, readdirSync, lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export function buildKey(root,paths,metadata) {
  const here=dirname(fileURLToPath(import.meta.url));
  const hash=createHash('sha256').update(JSON.stringify(metadata));
  for(const file of ['build-engine.mjs','lock-inputs.mjs'])hash.update(file).update('\0').update(readFileSync(join(here,file))).update('\0');
  for(const path of [...new Set(paths)].sort())hash.update(path).update('\0').update(readFileSync(join(root,path))).update('\0');
  return hash.digest('hex');
}
export function buildOutputInventory(root,c) {
  const files=new Map();
  function visit(path) {
    if(!existsSync(join(root,path)))throw Error(`BUILD_OUTPUT_MISSING: ${c.id}: ${path}`);
    const stat=lstatSync(join(root,path));
    if(stat.isSymbolicLink())throw Error(`BUILD_OUTPUT_SYMLINK: ${c.id}: ${path}`);
    if(stat.isDirectory())for(const name of readdirSync(join(root,path)).sort())visit(path+'/'+name);
    else if(stat.isFile()) {
      const bytes=readFileSync(join(root,path));
      files.set(path,{path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mode:stat.mode & 0o777});
    } else throw Error(`BUILD_OUTPUT_UNSUPPORTED: ${c.id}: ${path}`);
  }
  c.delivery.files.forEach(visit);
  return [...files.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function buildOutputDigest(root,c) {
  return createHash('sha256').update(JSON.stringify(buildOutputInventory(root,c))).digest('hex');
}
export function verifyBuildReceipt(root,c,state,build) {
  if(!c.commands.build)return;
  if(state.build!==build)throw Error(`BUILD_INPUTS_NOT_BUILT: ${c.id}`);
  if(!state.outputDigest)throw Error(`BUILD_OUTPUT_UNVERIFIED: ${c.id}: run explicit build`);
  if(state.outputDigest!==buildOutputDigest(root,c))throw Error(`BUILD_OUTPUT_MISMATCH: ${c.id}: run explicit build`);
}
export function command(root,c,text) {
  if(!text)return;
  const environment={...process.env,NEXT_TELEMETRY_DISABLED:'1'};
  delete environment.CODEX_TOOL_CALL_ID;
  const result=spawnSync(text,{cwd:join(root,c.directory),shell:true,stdio:'inherit',env:environment});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`COMMAND_FAILED: ${c.id}: ${text}: ${result.status}`);
}
