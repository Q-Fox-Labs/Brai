// ABOUTME: Копирует готовый индекс и оба графа SocratiCode без генерации embeddings.
// ABOUTME: Совместимость со storage 1.16.0 изолирована здесь; чужие ресурсы не присваиваются.
import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {command} from './git.mjs';
import {indexIdentity} from './code-index.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
const absent=error=>error.status===404;
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const waiting=reason=>({state:'waiting',reason});
const safeFile=(root,relative)=>{const file=path.resolve(root,relative);if(path.isAbsolute(relative)||!file.startsWith(root+'/'))throw Error('INDEX_PATH_INVALID');return file;};
const move=(value,from,to)=>Array.isArray(value)?value.map(v=>move(v,from,to)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[move(k,from,to),move(v,from,to)])):typeof value==='string'&&(value===from||value.startsWith(from+'/'))?to+value.slice(from.length):value;

/** Выполняет один fenced проход. Настройки и токен приходят от доверенного Activity, не из публичного API. */
export async function runIndexEngine({action,config,project,workspace:w,index:owned}){
  if(!['clone','update','remove'].includes(action)||owned.identity!==indexIdentity(w.path)||!path.isAbsolute(w.path)||path.dirname(w.path)!==project.workspace_root)throw Error('INDEX_OWNERSHIP_CONFLICT');
  const runtimeFile=typeof config.socraticodeConfig==='string'?config.socraticodeConfig:config.socraticodeConfig?.[w.kind];
  const settings=JSON.parse(await readFile(runtimeFile,'utf8'));
  const engine=config.engine;
  if(!path.isAbsolute(engine))throw Error('INDEX_ENGINE_REQUIRED');
  const root=path.dirname(engine),require=createRequire(engine);
  const manifest=JSON.parse(await readFile(path.join(root,'../package.json'),'utf8'));
  if(manifest.name!=='socraticode'||manifest.version!=='1.16.0')throw Error('UNSUPPORTED_SOCRATICODE_VERSION');
  Object.assign(process.env,settings.env,{SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'});
  if(process.env.SOCRATICODE_PROJECT_ID||process.env.SOCRATICODE_BRANCH_AWARE==='true')throw Error('PATH_IDENTITY_REQUIRED');
  // AIDEV-NOTE: Эти version-pinned exports — единственная граница с протоколом locks/storage внешнего движка.
  const native=relative=>import(pathToFileURL(path.join(root,relative)).href);
  const locks=await native('services/lock.js'),barriers=await native('services/reclamation-barrier.js');
  const {projectIdFromPath}=await native('config.js');
  if(action!=='remove'&&(await realpath(w.path)!==w.path||projectIdFromPath(w.path)!==owned.identity))throw Error('PATH_IDENTITY_REQUIRED');
  const {QdrantClient}=require('@qdrant/js-client-rest');
  const q=new QdrantClient({url:settings.env.QDRANT_URL,apiKey:settings.env.QDRANT_API_KEY,checkCompatibility:false,timeout:30000});
  const prefix=settings.env.QDRANT_COLLECTION_PREFIX??'',id=owned.identity;
  const names=identity=>[prefix+'codebase_'+identity,...['meta','file','index'].map(s=>prefix+identity+'_symgraph_'+s)];
  const metadata=prefix+'socraticode_metadata',base=names(id)[0],graph=prefix+'codegraph_'+id;
  let assertFence=()=>{};
  const point=async(collection,key)=>{
    try{return (await q.retrieve(collection,{ids:[key],with_payload:true,with_vector:true}))[0]??null;}
    catch(error){if(absent(error))return null;throw error;}
  };
  const ownershipKey=uuid(base+'::codeworks-owner');
  const master=()=>point(metadata,ownershipKey);
  const owner=record=>record?.payload?.codeworksOwner===w.ownership_token&&record.payload.projectPath===w.path;
  const upsert=async(collection,points)=>{
    let batch=[],size=0;
    for(const p of points){const bytes=Buffer.byteLength(JSON.stringify(p));if(batch.length&&size+bytes>2_000_000){assertFence();await q.upsert(collection,{points:batch,wait:true});batch=[];size=0;}batch.push(p);size+=bytes;}
    if(batch.length){assertFence();await q.upsert(collection,{points:batch,wait:true});}
  };
  const each=async(collection,consume,filter)=>{
    let offset;
    do{const page=await q.scroll(collection,{limit:32,with_payload:true,with_vector:true,...(filter?{filter}:{}),...(offset!==undefined?{offset}:{})});await consume(page.points);offset=page.next_page_offset??undefined;}while(offset!==undefined);
  };
  const list=async()=>new Set((await q.getCollections()).collections.map(c=>c.name));
  const existsResources=async()=>{const all=await list();return [...names(id),prefix+'context_'+id].some(n=>all.has(n))||!!await point(metadata,uuid(graph))||!!await point(metadata,uuid(prefix+'context_'+id));};
  if(action==='remove'){
    const barrier=await barriers.acquireReclamationBarrier(id);
    if(!barrier)throw Error('INDEX_WRITER_BUSY');
    assertFence=()=>{if(barrier.isCompromised())throw Error('INDEX_LOCK_LOST');};
    try{
      const record=await master();
      if(!record){if(await existsResources())throw Error('INDEX_OWNERSHIP_CONFLICT');return {state:'removed'};}
      if(!owner(record))throw Error('INDEX_OWNERSHIP_CONFLICT');
      for(const collection of [...names(id),prefix+'context_'+id]){
        if(barrier.isCompromised())throw Error('INDEX_LOCK_LOST');
        if((await list()).has(collection))await q.deleteCollection(collection);
      }
      // Ownership marker удаляется последним: повтор после частичного удаления всё ещё имеет доказательство.
      for(const name of [graph,prefix+'context_'+id,base]){
        if(barrier.isCompromised())throw Error('INDEX_LOCK_LOST');
        await q.delete(metadata,{points:[uuid(name)],wait:true});
      }
      await q.delete(metadata,{points:[ownershipKey],wait:true});
      if(await existsResources()||await master())throw Error('INDEX_CLEANUP_INCOMPLETE');
      return {state:'removed'};
    }finally{await barrier.release();}
  }
  if(action==='update'){
    if(!owner(await master()))throw Error('INDEX_OWNERSHIP_CONFLICT');
    const before=await point(metadata,uuid(base)),info=await q.getCollection(base);
    if(!before?.payload.fileHashes||!before.payload.effectiveIndexProfile||!info.points_count||!Object.keys(parse(before.payload.fileHashes)).length)throw Error('INDEX_UPDATE_REQUIRES_EXISTING_COPY');
    const result=await callNative('codebase_update',{});
    if(!/Updated project index:/.test(result)||/failed|error|warning/i.test(result))throw Error('INDEX_UPDATE_FAILED');
    const record=await point(metadata,uuid(base)),symbol=await point(names(id)[1],uuid(id+'::meta'));
    if(record?.payload.indexingStatus!=='completed'||!symbol?.payload.meta||!await point(metadata,uuid(graph)))throw Error('INDEX_UPDATE_INCOMPLETE');
    return {state:'ready'};
  }
  const source=owned.source_path;
  if(source!==config.sources?.[project.id]?.[w.kind]||source===w.path||await realpath(source)!==source||projectIdFromPath(source)!==indexIdentity(source))throw Error('INDEX_SOURCE_INVALID');
  const sourceId=indexIdentity(source),sourceNames=names(sourceId),sourceGraph=prefix+'codegraph_'+sourceId;
  if(sourceId===id)throw Error('INDEX_IDENTITY_COLLISION');
  const git=async args=>(await command('git',['-C',source,...args])).stdout;
  const head=()=>git(['rev-parse','HEAD']);
  if(await head()!==w.base_sha)return {state:'skipped',reason:'SOURCE_REVISION_CHANGED'};
  if(await git(['status','--porcelain','--untracked-files=normal']))return waiting('SOURCE_HAS_CHANGES');
  const acquired=[];let lost=false;
  assertFence=()=>{if(lost)throw Error('INDEX_LOCK_LOST');};
  try{
    for(const [identity,operation] of [[sourceId,'index'],[sourceId,'graph'],[id,'index'],[id,'graph']]){
      await barriers.assertNoReclamationBarrier(identity);
      if(!await locks.acquireIdentityLock(identity,operation,()=>{lost=true;},identity,false))return waiting('INDEX_WRITER_BUSY');
      acquired.push([identity,operation]);
    }
    const sourceMeta=await point(metadata,uuid(sourceNames[0])),sourceGraphPoint=await point(metadata,uuid(sourceGraph));
    const symbol=await point(sourceNames[1],uuid(sourceId+'::meta'));
    if(sourceMeta?.payload.indexingStatus!=='completed'||!sourceGraphPoint?.payload.graphInputs||symbol?.payload.meta?.schemaVersion!==2)return waiting('SOURCE_NOT_READY');
    const profile=parse(sourceMeta.payload.effectiveIndexProfile),hashes=parse(sourceMeta.payload.fileHashes);
    if(profile?.indexFormatVersion!==2||!hashes||!symbol.payload.meta.generation)throw Error('INDEX_FORMAT_UNSUPPORTED');
    const {getIndexableFiles}=await native('services/indexer.js');
    const {profileExtensionLanguageMap}=await native('services/index-profile.js');
    const {EXTRA_EXTENSIONS}=await native('constants.js');
    const discovered=await getIndexableFiles(source,EXTRA_EXTENSIONS,profileExtensionLanguageMap(profile)),files=[];
    for(const file of discovered)if((await stat(path.join(source,file))).size<=profile.maxFileBytes)files.push(file);
    if(files.length!==Object.keys(hashes).length)return waiting('SOURCE_NOT_CURRENT');
    for(const file of files){
      const absolute=safeFile(source,file),relative=file;
      if(hash(await readFile(absolute,'utf8')).slice(0,16)!==hashes[relative])return waiting('SOURCE_NOT_CURRENT');
    }
    let represented=0,staleSymbols=false;
    await each(sourceNames[2],async points=>{
      for(const p of points){
        if(p.payload.generation!==symbol.payload.meta.generation)continue;
        represented++;
        const f=p.payload.filePayload;
        if(!f||!f.file||hash(await readFile(safeFile(source,f.file),'utf8'))!==f.contentHash)staleSymbols=true;
      }
    });
    if(staleSymbols||represented!==symbol.payload.meta.fileCount)return waiting('SOURCE_SYMBOL_GRAPH_NOT_CURRENT');
    const {shouldRebuildGraph,ensureDynamicLanguages}=await native('services/code-graph.js');
    ensureDynamicLanguages();
    if((await shouldRebuildGraph(source,{changed:new Map(),removed:new Set(),unreadable:new Set(),knownHash:relative=>hashes[relative],hasAdditions:false},undefined,sourceId)).rebuild)return waiting('SOURCE_GRAPH_NOT_CURRENT');
    const existing=await master();
    if(existing&&!owner(existing)||!existing&&await existsResources())throw Error('INDEX_OWNERSHIP_CONFLICT');
    const marker={id:uuid(base),vector:[0],payload:{...sourceMeta.payload,projectPath:w.path,collectionName:base,codeworksOwner:w.ownership_token,indexingStatus:'in-progress'}};
    await upsert(metadata,[{id:ownershipKey,vector:[0],payload:{collectionName:base,projectPath:w.path,codeworksOwner:w.ownership_token}}]);
    await upsert(metadata,[marker]);
    const generation=randomUUID(),sourceGeneration=symbol.payload.meta.generation;
    for(let i=0;i<sourceNames.length;i++){
      if(lost)throw Error('INDEX_LOCK_LOST');
      const description=await q.getCollection(sourceNames[i]),params=description.config.params;
      if((await list()).has(names(id)[i]))await q.deleteCollection(names(id)[i]);
      await q.createCollection(names(id)[i],{vectors:params.vectors,...(params.sparse_vectors?{sparse_vectors:params.sparse_vectors}:{}),on_disk_payload:true});
      for(const [field,schema] of Object.entries(description.payload_schema??{}))await q.createPayloadIndex(names(id)[i],{field_name:field,field_schema:schema.data_type,wait:true});
      if(i===1)continue; // Symbol meta — указатель готовности, публикуется после всех файлов/shards.
      await each(sourceNames[i],async points=>{
        if(lost)throw Error('INDEX_LOCK_LOST');
        const copied=points.filter(p=>i===0||p.payload.generation===sourceGeneration).map(p=>{
          const payload=structuredClone(p.payload);let key=p.id;
          if(i===0){
            if(payload.filePath!==safeFile(source,payload.relativePath))throw Error('INDEX_PATH_INVALID');
            payload.filePath=move(payload.filePath,source,w.path);
          }
          else{
            payload.generation=generation;
            let seed;
            if(i===2)seed=`${id}::file::${payload.filePayload.file}::gen::${generation}`;
            else if(payload.kind==='name')seed=`${id}::nameidx::${payload.shard}::gen::${generation}`;
            else if(payload.kind==='reverse')seed=`${id}::revidx::${Number(payload.bucket).toString(16).padStart(2,'0')}::gen::${generation}`;
            else throw Error('INDEX_SHARD_UNSUPPORTED');
            if(payload.part>0)seed+=`::part${payload.part}`;
            key=uuid(seed);
          }
          return {id:key,vector:p.vector,payload};
        });
        await upsert(names(id)[i],copied);
      });
    }
    if(lost||await head()!==w.base_sha||await git(['status','--porcelain','--untracked-files=normal']))throw Error('SOURCE_CHANGED_DURING_COPY');
    const graphPayload={...sourceGraphPoint.payload,collectionName:graph,projectPath:w.path,graphData:JSON.stringify(move(parse(sourceGraphPoint.payload.graphData),source,w.path))};
    await upsert(metadata,[{id:uuid(graph),vector:[0],payload:graphPayload}]);
    await upsert(names(id)[1],[{id:uuid(id+'::meta'),vector:[0],payload:{meta:{...symbol.payload.meta,projectId:id,generation}}}]);
    await upsert(metadata,[{...marker,payload:{...marker.payload,indexingStatus:'completed'}}]);
    return {state:'ready'};
  }finally{for(const [identity,operation] of acquired.reverse())await locks.releaseIdentityLock(identity,operation);}

  async function callNative(name,args){
    const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
    const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
    const client=new Client({name:'codeworks-index',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[engine],cwd:w.path,env:{...process.env,SOCRATICODE_PROJECT_ID:id},stderr:'ignore'});
    try{await client.connect(transport);const result=await client.callTool({name,arguments:{...args,projectPath:w.path}},undefined,{timeout:1750000});if(result.isError)throw Error('INDEX_NATIVE_FAILED');return result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');}
    finally{await client.close();}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let input='';for await(const chunk of process.stdin)input+=chunk;
  try{console.log(JSON.stringify(await runIndexEngine(JSON.parse(input))));}
  catch(error){console.log(JSON.stringify({error:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'INDEX_ENGINE_FAILED'}));process.exitCode=1;}
}
