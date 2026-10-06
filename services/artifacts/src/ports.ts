// ABOUTME: Определяет внешние операции независимого ядра artifacts.
// ABOUTME: Порты не импортируют PostgreSQL, FS, NATS или HTTP.
import type {Artifact, ArtifactReference, ReferenceScope, ReferenceQueryScope} from "../contracts/index.mjs";
export type Metadata = Pick<Artifact,"title"|"filename"|"extension"|"mimeType"|"source"|"geotag"|"materialCreatedAt"|"details">;
export type Publication = {tempName:string; sizeBytes:number; sha256:string};
export type ArtifactRecord = {artifact:Artifact; prepareInput:{ownerId:string;kind:Artifact["kind"];metadata:Metadata}; uploadToken:string; publication?:Publication};
export type Relation = {modelArtifactId:string;originalArtifactId:string;createdAt:string};
export type Link = {linkId:string;artifactId:string;url:string;expiresAt:string|null;revokedAt:string|null};
export type LinkRecord = {link:Link;requestId:string;expiresInput:string|null;token:string};
export type ListInput = {filter:{ownerId:string;kind?:Artifact["kind"];status?:Artifact["status"];source?:string};sort:"createdAt"|"sizeBytes";order:"asc"|"desc";limit:number;offset:number};
export type Stats = {originalCount:number;copyCount:number;totalCount:number;originalBytes:number;copyBytes:number;totalBytes:number};
/** Результат потребляется внутри withLocks; возврат iterator освобождает незавершённую выборку. */
export type StoreItems<T> = Iterable<T> | AsyncIterable<T>;
/** Сессия под согласованными блокировками; отдельная запись фиксируется до возврата. */
export interface StoreSession {
  artifact(id:string):Promise<ArtifactRecord|undefined>;
  prepared(requestId:string):Promise<ArtifactRecord|undefined>;
  uploading(token:string):Promise<ArtifactRecord|undefined>;
  saveArtifact(record:ArtifactRecord, insert?:boolean):Promise<void>;
  list(input:ListInput):Promise<{items:StoreItems<Artifact>;total:number}>;
  stats(ownerId:string):Promise<Stats>;
  unfinished(afterId:string|undefined,limit:number):Promise<string[]>;
  relation(model:string,original:string):Promise<Relation|undefined>;
  saveRelation(relation:Relation):Promise<void>;
  removeRelation(model:string,original:string):Promise<void>;
  relations(artifactId:string,limit?:number):Promise<StoreItems<Relation>>;
  reference(scope:ReferenceScope):Promise<ArtifactReference|undefined>;
  saveReference(reference:ArtifactReference,insert?:boolean):Promise<void>;
  references(scope:ReferenceQueryScope,nativeItemIds:string[],limit?:number):Promise<StoreItems<ArtifactReference>>;
  link(id:string):Promise<LinkRecord|undefined>;
  requestedLink(requestId:string):Promise<LinkRecord|undefined>;
  shared(token:string):Promise<LinkRecord|undefined>;
  saveLink(record:LinkRecord,insert?:boolean):Promise<void>;
}
/** Межпроцессные блокировки удерживаются до конца work; tryOnly пропускает занятую запись. */
export interface ArtifactsStore {
  withLocks<T>(keys:string[],work:(session:StoreSession,signal:AbortSignal)=>Promise<T>,tryOnly?:boolean):Promise<T|undefined>;
}
/** Файловый порт использует только ID; write ограничивает память и очищает свой temp при ошибке. */
export interface ArtifactFiles {
  write(artifactId:string,source:AsyncIterable<Uint8Array>,maxBytes:number,signal?:AbortSignal):Promise<Publication>;
  publish(artifactId:string,publication:Publication):Promise<void>;
  inspect(artifactId:string):Promise<{sizeBytes:number;sha256:string}|undefined>;
  remove(artifactId:string):Promise<void>;
  removeTemp(tempName:string):Promise<void>;
  staleTemps(cutoffMs:number):AsyncIterable<{artifactId:string;tempName:string}>;
}
