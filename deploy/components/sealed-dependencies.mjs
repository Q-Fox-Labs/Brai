// ABOUTME: Сверяет выбранный npm closure с уже допущенным неизменяемым поколением.
// ABOUTME: Проверка происхождения proof выполняется вызывающей стороной перед каждым вызовом.
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

/** null означает, что следует выполнить обычный полный обход зависимостей. */
export function sealedInventory(root,entries,proof,generation) {
  try {
    if(process.env.NODE_PATH || process.env.NODE_OPTIONS || Object.entries(process.env).some(([key,value])=>key.startsWith('LD_')&&value))return null;
    const raw=readFileSync(join(generation,'package-lock.json'));
    const toolRaw=readFileSync(join(generation,'.brai-toolchain.json'));
    if(sha(raw)!==proof.lockSha256 || sha(toolRaw)!==proof.toolchainSha256)return null;
    const toolchain=JSON.parse(toolRaw);
    if(proof.node!==process.versions.node || toolchain.nodeAbi!==process.versions.modules ||
       toolchain.glibc!==`glibc ${process.report.getReport().header.glibcVersionRuntime}`)return null;
    const lock=JSON.parse(raw),closure=JSON.parse(readFileSync(join(generation,'.brai-closure.json')));
    if(!Array.isArray(closure.packages))return null;
    const packages=new Set(closure.packages);
    for(const {key,entry} of entries) {
      if(!key.split('/').includes('node_modules'))continue;
      if(entry.link) {
        if(realpathSync(join(root,key))!==realpathSync(join(root,entry.resolved)))return null;
      } else if(!packages.has(key) || !same(entry,lock.packages?.[key]) ||
                realpathSync(join(root,key))!==realpathSync(join(generation,key)))return null;
    }
    const engine=sha(readFileSync(fileURLToPath(import.meta.url)));
    return sha(JSON.stringify({format:'sealed-npm-inventory-v1',engine,content:proof.contentSha256,toolchain:proof.toolchainSha256,entries}));
  } catch {return null;}
}
