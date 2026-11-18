// ABOUTME: Проверяет разрешение host dependencies из принятого store вне checkout.
// ABOUTME: Providers берётся из payload; пользовательский cwd и незаявленные subpaths не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('host loader uses accepted exports and payload Providers, rejects provider subpaths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bug-hunt-loader-'));
 try{
  const store=join(root,'store/node_modules'),payload=join(root,'payload'),cwd=join(root,'caller');
  for(const path of [join(store,'fixture'),join(payload,'services/providers/dist'),join(cwd,'node_modules/fixture')])await mkdir(path,{recursive:true});
  for(const base of [join(store,'fixture'),join(cwd,'node_modules/fixture')]){
   await writeFile(join(base,'package.json'),JSON.stringify({name:'fixture',type:'module',exports:{import:'./esm.mjs',default:'./wrong.mjs'}}));
   await writeFile(join(base,'esm.mjs'),`export default ${JSON.stringify(base.startsWith(store)?'accepted':'mutable-cwd')};`);
  }
  await writeFile(join(payload,'services/providers/dist/package.json'),' {"type":"module"}');
  await writeFile(join(payload,'services/providers/dist/index.js'),'export default "payload-provider";');
  const loader=fileURLToPath(new URL('../runtime/node-loader.mjs',import.meta.url));
  const script='import assert from"node:assert/strict";assert.equal((await import("fixture")).default,"accepted");assert.equal((await import("@brai/providers")).default,"payload-provider");await assert.rejects(import("@brai/providers/private"),/BUG_HUNT_PROVIDERS_SUBPATH_FORBIDDEN/);console.log("closed-resolution");';
  const output=execFileSync(process.execPath,['--import',loader,'--input-type=module','-e',script],{cwd,encoding:'utf8',env:{PATH:'/usr/bin:/bin',BRAI_BUG_HUNT_NODE_MODULES:store,BRAI_BUG_HUNT_PAYLOAD:payload}});
  assert.equal(output.trim(),'closed-resolution');
 }finally{await rm(root,{recursive:true,force:true});}
});
