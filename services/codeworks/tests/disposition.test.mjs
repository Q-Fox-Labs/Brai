// ABOUTME: Проверяет доказательство точного переноса результата рабочей области.
// ABOUTME: Создаёт только изолированные временные Git-репозитории и не удаляет рабочие данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {command} from '../src/git.mjs';
import {verifyDisposition} from '../src/disposition.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'disposition-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const src=root+'/source',dst=root+'/destination';await mkdir(src);await mkdir(dst);
  const git=async(repo,...args)=>(await command('git',['-C',repo,...args])).stdout;
  for(const repo of [src,dst]){await git(repo,'init','-b','dev');await git(repo,'config','user.name','Fixture');await git(repo,'config','user.email','fixture@example.invalid');}
  await writeFile(src+'/old','old');await git(src,'add','.');await git(src,'commit','-m','base');const base=await git(src,'rev-parse','HEAD');
  await rm(src+'/old');await writeFile(src+'/new','exact\n');await git(src,'add','-A');await git(src,'commit','-m','change');const head=await git(src,'rev-parse','HEAD'),blob=await git(src,'rev-parse','HEAD:new');
  await writeFile(dst+'/copy','exact\n');await git(dst,'add','.');await git(dst,'commit','-m','transfer');const commit=await git(dst,'rev-parse','HEAD');
  const project={repo_path:src,common_dir:src+'/.git'},w={path:src,base_sha:base};
  const evidence={destination:{repo_path:dst,commit_sha:commit},source_head:head,source_base:base,files:[{status:'A',source_path:'new',destination_path:'copy',source_blob:blob,destination_blob:blob},{status:'D',source_path:'old',destination_path:'old',source_blob:null,destination_blob:null}]};
  const verify=(e=evidence)=>verifyDisposition(project,w,e,{allowedRepositories:[src,dst]});
  return {src,dst,git,evidence,verify};
}

test('proves complete additions and deletions on a permanent branch',async t=>{
  const f=await fixture(t),proof=await f.verify();
  assert.equal(proof.destination.ref,'refs/heads/dev');assert.equal(proof.files[0].source_mode,'100644');assert.equal(proof.files[1].source_mode,null);
});
test('rejects omitted changes, dirty source, and altered destination',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.verify({...f.evidence,files:f.evidence.files.slice(0,1)}),{code:'TRANSFER_UNVERIFIED'});
  await writeFile(f.src+'/dirty','untracked');await assert.rejects(f.verify(),{code:'TRANSFER_UNVERIFIED'});await rm(f.src+'/dirty');
  await writeFile(f.dst+'/copy','different');await f.git(f.dst,'add','.');await f.git(f.dst,'commit','-m','changed');await assert.rejects(f.verify(),{code:'TRANSFER_UNVERIFIED'});
});
test('rejects wrong modes, forged blobs, non-allowlisted and unanchored destination',async t=>{
  const f=await fixture(t);await chmod(f.dst+'/copy',0o755);await f.git(f.dst,'add','.');await f.git(f.dst,'commit','-m','mode');
  await assert.rejects(f.verify(),{code:'TRANSFER_UNVERIFIED'});
  const bad=structuredClone(f.evidence);bad.files[0].source_blob='0'.repeat(40);await assert.rejects(f.verify(bad),{code:'TRANSFER_UNVERIFIED'});
  await assert.rejects(verifyDisposition({repo_path:f.src,common_dir:f.src+'/.git'},{path:f.src,base_sha:f.evidence.source_base},f.evidence,{allowedRepositories:[f.src]}),{code:'TRANSFER_UNVERIFIED'});
});
test('compares symlink type and contents',async t=>{
  const f=await fixture(t);await rm(f.src+'/new');await symlink('target',f.src+'/new');await f.git(f.src,'add','.');await f.git(f.src,'commit','-m','link');
  const head=await f.git(f.src,'rev-parse','HEAD'),blob=await f.git(f.src,'rev-parse','HEAD:new');
  const evidence=structuredClone(f.evidence);evidence.source_head=head;evidence.files[0].source_blob=blob;evidence.files[0].destination_blob=blob;
  await assert.rejects(f.verify(evidence),{code:'TRANSFER_UNVERIFIED'});
});
