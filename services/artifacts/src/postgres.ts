// ABOUTME: Подключает PostgreSQL к портам хранения artifacts.
// ABOUTME: Runtime выполняет только DML и удерживает межпроцессные advisory locks.
import type {Pool,PoolClient} from "pg";
import type {ArtifactsStore,StoreSession,ArtifactRecord,LinkRecord,ListInput,Relation,Stats} from "./ports.js";
import type {ArtifactReference,ReferenceScope,ReferenceQueryScope} from "../contracts/index.mjs";
import {ArtifactError,storageError} from "./errors.js";
export type PostgresOptions={lockTimeoutMs?:number;queryTimeoutMs?:number};
const scopeValues=(s:ReferenceScope|ReferenceQueryScope)=>[s.ownerId,s.projectId,s.threadId,...("operationId" in s?[s.operationId]:[])];
const numeric=(value:unknown)=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new ArtifactError("INTERNAL");return number;};
function unsupportedUnicode(value:unknown):boolean {
  if(typeof value==="string"){
    for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code===0)return true;if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return true;}else if(code>=0xdc00&&code<=0xdfff)return true;}
  }else if(value&&typeof value==="object")return Object.entries(value).some(([key,item])=>unsupportedUnicode(key)||unsupportedUnicode(item));
  return false;
}
function session(client:PoolClient,timeout:number,onFailure:()=>void):StoreSession {
  const query=(text:string,values:unknown[]=[])=>{const config={text,values,query_timeout:timeout};return client.query(config).catch(error=>{
    onFailure();
    // AIDEV-NOTE: 22P02 бывает при повреждении данных; 400 допустим лишь с известным неподдерживаемым Unicode во входе.
    if(["22P05","22021","22P02"].includes(error.code)&&unsupportedUnicode(values))throw new ArtifactError("INVALID_ARGUMENT",{cause:error});
    throw error;
  });};
  const one=async<T>(text:string,values:unknown[])=>{const {rows}=await query(text,values);return rows[0]?.document as T|undefined;};
  const artifact=(id:string)=>one<ArtifactRecord>("SELECT document FROM artifacts.artifacts WHERE artifact_id=$1",[id]);
  async function* cursor<T>(text:string,values:unknown[],map:(document:unknown)=>T,started=false):AsyncIterable<T> {
    let committed=false;
    try{
      if(!started)await query("BEGIN READ ONLY");
      await query(`DECLARE artifacts_page NO SCROLL CURSOR FOR ${text}`,values);
      while(true){const {rows}=await query("FETCH FORWARD 16 FROM artifacts_page");if(!rows.length)break;for(const row of rows)yield map(row.document);}
      await query("CLOSE artifacts_page");await query("COMMIT");committed=true;
    }finally{if(!committed)await query("ROLLBACK").catch(()=>{});}
  }
  return {
    artifact,
    prepared:requestId=>one<ArtifactRecord>("SELECT document FROM artifacts.artifacts WHERE request_id=$1",[requestId]),
    uploading:token=>one<ArtifactRecord>("SELECT document FROM artifacts.artifacts WHERE upload_token=$1",[token]),
    async saveArtifact(record,insert=false){
      const a=record.artifact;
      if(insert)await query("INSERT INTO artifacts.artifacts(artifact_id,request_id,owner_id,kind,status,source,size_bytes,created_at,upload_token,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[a.artifactId,a.requestId,a.ownerId,a.kind,a.status,a.source,a.sizeBytes,a.createdAt,record.uploadToken,record]);
      else {const result=await query("UPDATE artifacts.artifacts SET status=$2,source=$3,size_bytes=$4,document=$5 WHERE artifact_id=$1",[a.artifactId,a.status,a.source,a.sizeBytes,record]);if(!result.rowCount)throw new ArtifactError("NOT_FOUND");}
    },
    async list(input:ListInput){
      const values:unknown[]=[input.filter.ownerId];let where="owner_id=$1";
      for(const [field,column] of [["kind","kind"],["status","status"],["source","source"]] as const)if(input.filter[field]!==undefined){values.push(input.filter[field]);where+=` AND ${column}=$${values.length}`;}
      const column=input.sort==="sizeBytes"?"size_bytes":"created_at",order=input.order==="asc"?"ASC":"DESC";
      // AIDEV-NOTE: Снимок связывает total и страницу при конкурентных изменениях.
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try{
        const total=numeric((await query(`SELECT count(*) AS total FROM artifacts.artifacts WHERE ${where}`,values)).rows[0].total);
        return {total,items:cursor(`SELECT document->'artifact' AS document FROM artifacts.artifacts WHERE ${where} ORDER BY ${column} ${order} NULLS LAST,artifact_id ${order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.limit,input.offset],document=>document as ArtifactRecord["artifact"],true)};
      }catch(error){await query("ROLLBACK").catch(()=>{});throw error;}
    },
    async stats(ownerId){
      const {rows}=await query("SELECT kind,count(*) AS count,COALESCE(sum(size_bytes),0) AS bytes FROM artifacts.artifacts WHERE owner_id=$1 AND status='ready' GROUP BY kind",[ownerId]);
      const result:Stats={originalCount:0,copyCount:0,totalCount:0,originalBytes:0,copyBytes:0,totalBytes:0};
      for(const row of rows){if(row.kind==="original"){result.originalCount=numeric(row.count);result.originalBytes=numeric(row.bytes);}else{result.copyCount=numeric(row.count);result.copyBytes=numeric(row.bytes);}}
      result.totalCount=numeric(result.originalCount+result.copyCount);result.totalBytes=numeric(result.originalBytes+result.copyBytes);return result;
    },
    async unfinished(afterId,limit){return (await query("SELECT artifact_id FROM artifacts.artifacts WHERE status IN ('pending','failed','deleting') AND ($1::uuid IS NULL OR artifact_id>$1::uuid) ORDER BY artifact_id LIMIT $2",[afterId??null,limit])).rows.map(row=>row.artifact_id);},
    relation:(model,original)=>one<Relation>("SELECT document FROM artifacts.artifact_relations WHERE model_artifact_id=$1 AND original_artifact_id=$2",[model,original]),
    async saveRelation(relation){await query("INSERT INTO artifacts.artifact_relations(model_artifact_id,original_artifact_id,document) VALUES($1,$2,$3)",[relation.modelArtifactId,relation.originalArtifactId,relation]);},
    async removeRelation(model,original){await query("DELETE FROM artifacts.artifact_relations WHERE model_artifact_id=$1 AND original_artifact_id=$2",[model,original]);},
    async relations(artifactId,limit){return cursor("SELECT document FROM artifacts.artifact_relations WHERE model_artifact_id=$1 OR original_artifact_id=$1 ORDER BY model_artifact_id,original_artifact_id LIMIT $2",[artifactId,limit??null],document=>document as Relation);},
    reference:s=>one<ArtifactReference>("SELECT document FROM artifacts.artifact_references WHERE owner_id=$1 AND project_id=$2 AND thread_id=$3 AND operation_id=$4",scopeValues(s)),
    async saveReference(reference,insert=false){
      const params=[...scopeValues(reference.scope),reference];
      if(insert)await query("INSERT INTO artifacts.artifact_references(owner_id,project_id,thread_id,operation_id,document) VALUES($1,$2,$3,$4,$5)",params);
      else {const result=await query("UPDATE artifacts.artifact_references SET document=$5 WHERE owner_id=$1 AND project_id=$2 AND thread_id=$3 AND operation_id=$4",params);if(!result.rowCount)throw new ArtifactError("NOT_FOUND");}
    },
    async references(s,ids,limit){if(!ids.length)return [];return cursor("SELECT document FROM artifacts.artifact_references WHERE owner_id=$1 AND project_id=$2 AND thread_id=$3 AND document->>'itemId'=ANY($4::text[]) ORDER BY operation_id LIMIT $5",[...scopeValues(s),ids,limit??null],document=>document as ArtifactReference);},
    link:id=>one<LinkRecord>("SELECT document FROM artifacts.artifact_links WHERE link_id=$1",[id]),
    requestedLink:requestId=>one<LinkRecord>("SELECT document FROM artifacts.artifact_links WHERE request_id=$1",[requestId]),
    shared:token=>one<LinkRecord>("SELECT document FROM artifacts.artifact_links WHERE token=$1",[token]),
    async saveLink(record,insert=false){
      if(insert)await query("INSERT INTO artifacts.artifact_links(link_id,request_id,artifact_id,token,document) VALUES($1,$2,$3,$4,$5)",[record.link.linkId,record.requestId,record.link.artifactId,record.token,record]);
      else {const result=await query("UPDATE artifacts.artifact_links SET document=$2 WHERE link_id=$1",[record.link.linkId,record]);if(!result.rowCount)throw new ArtifactError("NOT_FOUND");}
    }
  };
}
/** Использует отдельную Pool; её connectionTimeoutMillis задаёт сборка процесса. */
export function createPostgresStore(pool:Pool,{lockTimeoutMs=5000,queryTimeoutMs=10000}:PostgresOptions={}):ArtifactsStore {
  if(!Number.isSafeInteger(lockTimeoutMs)||lockTimeoutMs<1||lockTimeoutMs>2147483647||!Number.isSafeInteger(queryTimeoutMs)||queryTimeoutMs<1||queryTimeoutMs>2147483647)throw new ArtifactError("INVALID_ARGUMENT");
  return {
    /** Все keys сортируются; потеря соединения отменяет поток и освобождает session locks на сервере. */
    async withLocks(keys,work,tryOnly=false){
      let client:PoolClient|undefined;const held:string[]=[],controller=new AbortController();let broken=false;
      const onError=()=>{broken=true;controller.abort();};
      try{
        client=await pool.connect();client.on("error",onError);
        const query=(text:string,values:unknown[]=[])=>{const config={text,values,query_timeout:queryTimeoutMs};return client!.query(config).catch(error=>{if(["22P05","22021","22P02"].includes(error.code)&&unsupportedUnicode(values))throw new ArtifactError("INVALID_ARGUMENT",{cause:error});throw error;});};
        await query("SELECT set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)",[`${lockTimeoutMs}ms`,`${queryTimeoutMs}ms`]);
        for(const key of [...new Set(keys)].sort()){
          const {rows}=await query(tryOnly?"SELECT pg_try_advisory_lock(hashtextextended($1,73490217)) AS acquired":"SELECT pg_advisory_lock(hashtextextended($1,73490217)),true AS acquired",[key]);
          if(!rows[0].acquired)return undefined;held.push(key);
        }
        return await work(session(client,queryTimeoutMs,onError),controller.signal);
      }catch(error){if(!(error instanceof ArtifactError))broken=true;throw storageError(error);}finally{
        if(client){
          // AIDEV-NOTE: При неясном unlock выбрасываем соединение, иначе pool удержит чужую блокировку.
          for(const key of held.reverse())try{const config={text:"SELECT pg_advisory_unlock(hashtextextended($1,73490217))",values:[key],query_timeout:queryTimeoutMs};await client.query(config);}catch{broken=true;break;}
          client.removeListener("error",onError);client.release(broken);
        }
      }
    }
  };
}
