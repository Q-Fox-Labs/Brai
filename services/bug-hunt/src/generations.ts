// ABOUTME: Регистрирует неизменяемые метаданные поколений и сохраняет активный указатель.
// ABOUTME: Подготовка build не меняет active; selector выбирает только код, не вход модели.
import type {PoolClient} from "pg";
import {canonical} from "./contracts.js";
import {EMBEDDING_MODEL,GENERATION,PROJECTION_VERSION} from "./projection.js";
import {PIPELINE_VERSION} from "./processing.js";
export const generationPattern=/^[a-z0-9][a-z0-9._-]{0,63}$/;
export interface GenerationMetadata {
 model_id:string;model_revision:string;profile_id:string;projection_version:string;
 chunking_version:string;purpose:string;dimensions:number;pipeline_version:string;
}
export const generationMetadata:GenerationMetadata={
 model_id:EMBEDDING_MODEL.modelId,model_revision:EMBEDDING_MODEL.revision,profile_id:EMBEDDING_MODEL.profileId,
 projection_version:PROJECTION_VERSION,chunking_version:"utf8-1200-64-65536-v1",purpose:"symmetric",dimensions:768,pipeline_version:PIPELINE_VERSION,
};
// AIDEV-NOTE: Инициализация upgrade всегда использует исходные метаданные, даже в новой версии pipeline.
const legacyGeneration="gemma2-symmetric-v1";
const legacyMetadata:GenerationMetadata={
 model_id:"embeddinggemma-2-q8",model_revision:"bfcd298762cc34d0357ece5ebdd31791a3a374d8",profile_id:"embeddinggemma2_llama_cpp",
 projection_version:"1",chunking_version:"utf8-1200-64-65536-v1",purpose:"symmetric",dimensions:768,pipeline_version:"2",
};
export interface GenerationState {active_generation:string;activation_revision:number}
/** Вызывается в короткой транзакции, в том числе intake. Блокировка сериализует первый запуск и активацию. */
export async function prepareGenerations(db:Pick<PoolClient,"query">,installation:string,target=GENERATION):Promise<GenerationState>{
 if(!generationPattern.test(target))throw new Error("INVALID_GENERATION");
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,57))",[installation]);
 for(const generation of new Set([legacyGeneration,target])){
  const metadata=generation===target?generationMetadata:legacyMetadata;
  await db.query("INSERT INTO embedding_generation(installation_id,generation,metadata) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[installation,generation,metadata]);
  const saved=(await db.query("SELECT metadata FROM embedding_generation WHERE installation_id=$1 AND generation=$2",[installation,generation])).rows[0];
  if(canonical(saved.metadata)!==canonical(metadata))throw new Error("GENERATION_METADATA_CONFLICT");
 }
 // AIDEV-NOTE: При первом запуске нового кода legacy active сохраняется, даже если build уже другой.
 await db.query("INSERT INTO embedding_generation_control(installation_id,active_generation) VALUES($1,$2) ON CONFLICT DO NOTHING",[installation,legacyGeneration]);
 return (await db.query("SELECT active_generation,activation_revision FROM embedding_generation_control WHERE installation_id=$1",[installation])).rows[0];
}
