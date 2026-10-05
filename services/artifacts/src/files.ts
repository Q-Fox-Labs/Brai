// ABOUTME: Сохраняет ограниченный поток в собственном файловом томе artifacts.
// ABOUTME: Публикует неизменяемые ID без перезаписи; имена пользователя не входят в путь.
import {mkdir,open,link,unlink,opendir,lstat,chmod} from "node:fs/promises";
import {constants} from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import type {ArtifactFiles,Publication} from "./ports.js";
import {ArtifactError,storageError} from "./errors.js";
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tempPattern=/^([0-9a-f-]{36})\.([0-9a-f-]{36})\.part$/;
function id(value:string){const lower=value.toLowerCase();if(!idPattern.test(lower))throw new ArtifactError("INVALID_ARGUMENT");return lower;}
function temp(value:string){const match=tempPattern.exec(value);if(!match||!idPattern.test(match[1])||!idPattern.test(match[2]))throw new ArtifactError("INVALID_ARGUMENT");return value;}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==="ENOENT";
/** Создаёт files/ и tmp/; директория принадлежит сервису, Caddy читает только files/. */
export async function createFileStore(root:string):Promise<ArtifactFiles> {
  const directory=resolve(root),published=join(directory,"files"),temporary=join(directory,"tmp");
  await mkdir(published,{recursive:true,mode:0o750});await mkdir(temporary,{recursive:true,mode:0o700});
  async function syncDirectory(path:string){const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);try{await handle.sync();}finally{await handle.close();}}
  async function removeTemp(name:string){try{await unlink(join(temporary,temp(name)));await syncDirectory(temporary);}catch(error){if(!missing(error))throw storageError(error);}}
  return {
    /** Читает по одному пакету; abort прерывает ожидание producer и удаляет свой temp. */
    async write(artifactId,source,maxBytes,signal){
      const name=id(artifactId)+"."+randomUUID()+".part",path=join(temporary,name);
      let handle:Awaited<ReturnType<typeof open>>|undefined,iterator:AsyncIterator<Uint8Array>|undefined;
      const nextPacket=()=>new Promise<IteratorResult<Uint8Array>>((resolve,reject)=>{
        const onAbort=()=>{signal?.removeEventListener("abort",onAbort);reject(new ArtifactError("STORAGE_UNAVAILABLE"));};
        if(signal?.aborted){onAbort();return;}
        signal?.addEventListener("abort",onAbort,{once:true});
        Promise.resolve().then(()=>iterator!.next()).then(value=>{signal?.removeEventListener("abort",onAbort);resolve(value);},error=>{signal?.removeEventListener("abort",onAbort);reject(error);});
      });
      // AIDEV-NOTE: Снимаем listener после каждого next: один общий race-Promise удерживал бы все пакеты.
      try{
        signal?.throwIfAborted();handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
        const hash=createHash("sha256");let sizeBytes=0;iterator=source[Symbol.asyncIterator]();
        while(true){
          const packet=await nextPacket();if(packet.done)break;
          if(!(packet.value instanceof Uint8Array))throw new ArtifactError("INVALID_ARGUMENT");
          sizeBytes+=packet.value.byteLength;
          if(!Number.isSafeInteger(sizeBytes)||sizeBytes>maxBytes)throw new ArtifactError("PAYLOAD_TOO_LARGE");
          hash.update(packet.value);
          for(let offset=0;offset<packet.value.byteLength;){signal?.throwIfAborted();const length=Math.min(65536,packet.value.byteLength-offset);const {bytesWritten}=await handle.write(packet.value,offset,length);if(!bytesWritten)throw new ArtifactError("STORAGE_UNAVAILABLE");offset+=bytesWritten;}
        }
        signal?.throwIfAborted();await handle.sync();await handle.close();handle=undefined;await syncDirectory(temporary);
        return {tempName:name,sizeBytes,sha256:hash.digest("hex")};
      }catch(error){
        try{Promise.resolve(iterator?.return?.()).catch(()=>{});}catch{}
        await handle?.close().catch(()=>{});await removeTemp(name).catch(()=>{});throw storageError(error);
      }
    },
    /** link публикует полный fsync-нутый inode и никогда не заменяет существующий ID. */
    async publish(artifactId:string,publication:Publication){
      try{
        const source=join(temporary,temp(publication.tempName));if(!publication.tempName.startsWith(id(artifactId)+"."))throw new ArtifactError("INVALID_ARGUMENT");
        await chmod(source,0o640);
        const handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}
        // AIDEV-NOTE: Hard link даёт atomic no-replace на том же томе; rename может перезаписать готовый файл.
        await link(source,join(published,id(artifactId)));await syncDirectory(published);await removeTemp(publication.tempName);
      }catch(error){if((error as NodeJS.ErrnoException)?.code==="EEXIST")throw new ArtifactError("CONFLICT");throw storageError(error);}
    },
    /** Сверяет опубликованный размер и SHA-256 потоком, без загрузки файла в память. */
    async inspect(artifactId){
      let handle:Awaited<ReturnType<typeof open>>|undefined;
      try{
        handle=await open(join(published,id(artifactId)),constants.O_RDONLY|constants.O_NOFOLLOW);
        if(!(await handle.stat()).isFile())throw new ArtifactError("STORAGE_UNAVAILABLE");
        const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let sizeBytes=0;
        while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;sizeBytes+=bytesRead;hash.update(buffer.subarray(0,bytesRead));}
        return {sizeBytes,sha256:hash.digest("hex")};
      }catch(error){if(missing(error))return undefined;throw storageError(error);}finally{await handle?.close();}
    },
    /** Удаляет только указанный ID; повтор ENOENT безопасен, fsync подтверждает unlink. */
    async remove(artifactId){try{await unlink(join(published,id(artifactId))).catch(error=>{if(!missing(error))throw error;});await syncDirectory(published);}catch(error){throw storageError(error);}},
    removeTemp,
    /** Перебирает temp последовательно; чужие имена и символические ссылки пропускает. */
    async *staleTemps(cutoffMs){
      try{
        const entries=await opendir(temporary);
        for await(const entry of entries){const match=tempPattern.exec(entry.name);if(!match||!entry.isFile()||!idPattern.test(match[1])||!idPattern.test(match[2]))continue;
          const info=await lstat(join(temporary,entry.name)).catch(error=>{if(missing(error))return undefined;throw error;});
          if(info&&info.mtimeMs<=cutoffMs)yield {artifactId:match[1],tempName:entry.name};
        }
      }catch(error){throw storageError(error);}
    }
  };
}
