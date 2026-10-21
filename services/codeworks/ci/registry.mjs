// ABOUTME: Читает immutable GHCR manifests/config и публикует OCI через существующий Docker.
// ABOUTME: Не устанавливает Docker; credentials не попадают в аргументы или журналы.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
/** Выполняет один ограниченный процесс; секретный stdin никогда не выводится. */
export function run(exe,args,{cwd,input,quiet=false,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error(`PROCESS_TIMEOUT: ${exe}`));},20*60*1000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024)child.kill('SIGKILL');if(!quiet)process.stdout.write(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-65536);if(!quiet)process.stderr.write(chunk);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code===0)resolve({stdout,stderr});else reject(Error(`PROCESS_FAILED: ${exe}: ${code}`));});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export const sha256=value=>createHash('sha256').update(value).digest('hex');
function jsonLayer(name,value) {
  const data=Buffer.from(JSON.stringify(value));if(data.length>1024*1024)throw Error('CATALOG_TOO_LARGE');
  const header=Buffer.alloc(512),octal=(value,width)=>value.toString(8).padStart(width-1,'0')+'\0';
  header.write(name);header.write(octal(0o644,8),100);header.write(octal(0,8),108);header.write(octal(0,8),116);header.write(octal(data.length,12),124);header.write(octal(0,12),136);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
  header.write(octal([...header].reduce((a,b)=>a+b,0),7)+' ',148);
  const raw=Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512+1024)]);
  return {raw,compressed:gzipSync(raw)};
}
/** HTTP 404 означает отсутствие; auth/сеть/повреждение не превращаются в cache miss. */
export function createRegistry({repository,username,token,fetcher=fetch}) {
  const prefix=`ghcr.io/${repository.toLowerCase()}-components`;
  const tokens=new Map();
  async function authorization(path,scope='pull') {
    const key=path+'/'+scope;
    if(!tokens.has(key)) {
      const auth=await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:${scope}`,{headers:{Authorization:'Basic '+Buffer.from(`${username}:${token}`).toString('base64')},signal:AbortSignal.timeout(30000)});
      if(!auth.ok)throw Error(`REGISTRY_AUTH_UNAVAILABLE: ${auth.status}`);
      const body=await auth.json();if(!body.token)throw Error('REGISTRY_AUTH_INVALID');tokens.set(key,body.token);
    }
    return 'Bearer '+tokens.get(key);
  }
  async function get(path,reference,kind='manifests',raw=false) {
    const response=await fetcher(`https://ghcr.io/v2/${path}/${kind}/${reference}`,{headers:{Authorization:await authorization(path),Accept:'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'},signal:AbortSignal.timeout(60000)});
    if(response.status===404)return null;
    if(!response.ok)throw Error(`REGISTRY_READ_UNAVAILABLE: ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>4*1024*1024)throw Error('REGISTRY_METADATA_TOO_LARGE');
    const digest='sha256:'+sha256(bytes);
    if(reference.startsWith('sha256:')&&reference!==digest)throw Error('REGISTRY_DIGEST_MISMATCH');
    return {document:raw?bytes:JSON.parse(bytes),digest};
  }
  async function write(path,url,{method='PUT',body,type='application/octet-stream',expected=201}={}) {
    const target=new URL(url,'https://ghcr.io');
    if(target.origin!=='https://ghcr.io'||!target.pathname.startsWith('/v2/'+path+'/'))throw Error('REGISTRY_UPLOAD_LOCATION_INVALID');
    const response=await fetcher(target,{method,headers:{Authorization:await authorization(path,'pull,push'),'Content-Type':type},body,redirect:'error',signal:AbortSignal.timeout(60000)});
    if(response.status!==expected)throw Error(`REGISTRY_WRITE_UNCERTAIN: ${response.status}`);return response;
  }
  return {
    prefix,
    reference:(id,tag)=>`${prefix}/${id}:${tag}`,
    async lookup(id,tag) {
      const path=`${repository.toLowerCase()}-components/${id}`,manifest=await get(path,tag);
      if(!manifest)return null;
      if(!manifest.document.config?.digest)throw Error('REGISTRY_MANIFEST_INVALID');
      const config=await get(path,manifest.document.config.digest,'blobs');
      if(!config)throw Error('REGISTRY_CONFIG_MISSING');
      let metadata;
      try{metadata=JSON.parse(config.document.config?.Labels?.['app.brai.codeworks']);}catch{throw Error('REGISTRY_PROVENANCE_INVALID');}
      return {reference:`ghcr.io/${path}@${manifest.digest}`,digest:manifest.digest,metadata,bytes:manifest.document.layers?.reduce((n,layer)=>n+layer.size,0)??0};
    },
    /** Читает один JSON из маленького scratch OCI без Docker pull и извлечения на диск. */
    async readJSON(id,digest,name) {
      if(!/^sha256:[0-9a-f]{64}$/.test(digest))throw Error('IMMUTABLE_DIGEST_REQUIRED');
      const path=`${repository.toLowerCase()}-components/${id}`,manifest=await get(path,digest);
      if(manifest?.document.layers?.length!==1)throw Error('COMPOSITION_LAYER_INVALID');
      const layer=manifest.document.layers[0];if(layer.size>2*1024*1024)throw Error('COMPOSITION_TOO_LARGE');
      const blob=await get(path,layer.digest,'blobs',true);if(!blob)throw Error('COMPOSITION_LAYER_MISSING');
      const bytes=layer.mediaType.endsWith('+gzip')||layer.mediaType.endsWith('.gzip')?gunzipSync(blob.document,{maxOutputLength:4*1024*1024}):blob.document;
      let result;
      for(let offset=0;offset+512<=bytes.length;) {
        const header=bytes.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
        const key=header.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8);
        if(!Number.isSafeInteger(size)||size<0||offset+512+size>bytes.length)throw Error('COMPOSITION_TAR_INVALID');
        if(key===name){if(result!==undefined)throw Error('COMPOSITION_DUPLICATE_FILE');result=JSON.parse(bytes.subarray(offset+512,offset+512+size));}
        offset+=512+Math.ceil(size/512)*512;
      }
      if(result===undefined)throw Error('COMPOSITION_FILE_MISSING');return result;
    },
    async login(){await run('docker',['login','ghcr.io','--username',username,'--password-stdin'],{input:token,quiet:true});},
    /** Owner catalog не требует Docker/daemon: только маленькие OCI blobs стандартного Registry API. */
    async publishJSON(id,tag,name,value,metadata,{alias,existing}={}) {
      const path=`${repository.toLowerCase()}-components/${id}`;
      let manifest;
      if(existing)manifest=(await get(path,existing.digest)).document;
      else {
        const layer=jsonLayer(name,value),config=Buffer.from(JSON.stringify({architecture:'amd64',os:'linux',config:{Labels:{'org.opencontainers.image.source':'https://github.com/'+repository,'app.brai.codeworks':JSON.stringify(metadata)}},rootfs:{type:'layers',diff_ids:['sha256:'+sha256(layer.raw)]}}));
        for(const blob of [config,layer.compressed]) {
          const started=await write(path,`/v2/${path}/blobs/uploads/`,{method:'POST',expected:202});
          const location=new URL(started.headers.get('location'),'https://ghcr.io');location.searchParams.set('digest','sha256:'+sha256(blob));
          await write(path,location,{body:blob});
        }
        manifest={schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:'sha256:'+sha256(config),size:config.length},layers:[{mediaType:'application/vnd.oci.image.layer.v1.tar+gzip',digest:'sha256:'+sha256(layer.compressed),size:layer.compressed.length}]};
      }
      const body=Buffer.from(JSON.stringify(manifest)),digest='sha256:'+sha256(body),type=manifest.mediaType;
      if(!existing)await write(path,`/v2/${path}/manifests/${tag}`,{body,type});
      if(alias)await write(path,`/v2/${path}/manifests/${alias}`,{body,type});
      const hit=await this.lookup(id,digest);if(!hit)throw Error('CATALOG_PUBLICATION_UNCONFIRMED');return hit;
    },
    async publish(id,tag,context,metadata,{layers=false,existingImage}={}) {
      const started=Date.now();let layerCacheHits=0;
      const ref=`${prefix}/${id}:${tag}`;
      const args=['buildx','build','--platform','linux/amd64','--provenance=false','--load','--tag',ref,'--label','app.brai.codeworks='+JSON.stringify(metadata)];
      if(layers)args.push('--cache-from',`type=registry,ref=${prefix}/${id}:layers`,'--cache-to','type=inline');
      if(existingImage)await run('docker',['tag',existingImage,ref]);
      else {const output=await run('docker',[...args,context]);layerCacheHits=(output.stdout+'\n'+output.stderr).match(/\bCACHED\b/g)?.length??0;}
      await run('docker',['push',ref]);
      if(layers){await run('docker',['tag',ref,`${prefix}/${id}:layers`]);await run('docker',['push',`${prefix}/${id}:layers`]);}
      const result=await this.lookup(id,tag);if(!result)throw Error('PUBLICATION_UNCONFIRMED');return {...result,publicationMs:Date.now()-started,layerCacheHits};
    },
  };
}
