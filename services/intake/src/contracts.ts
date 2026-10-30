// ABOUTME: Проверяет входной JSON и хеширует точное предметное содержимое.
// ABOUTME: Схема не заменяет проверку доверенного источника ядром.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { Fault, type Event, type Packet, type Job, type Data } from './types.js';
const ajv = new Ajv({ strict: false });
const addFormats = addFormatsModule as unknown as (instance: Ajv) => void;
addFormats(ajv);
const schema=JSON.parse(readFileSync(new URL('../schemas/messages.schema.json', import.meta.url), 'utf8'));
const validate = ajv.compile(schema);
const validateMaterial=ajv.compile({$ref:schema.$id+'#/definitions/MaterialResult'});
const validateMemory=ajv.compile({$ref:schema.$id+'#/definitions/MemoryResult'});
const validateQuery=ajv.compile({$ref:schema.$id+'#/definitions/GetRequest'});
/** Канонизирует JSON без перестановки элементов массивов. */
export function canonical(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
 if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
 return JSON.stringify(value);
}
/** Возвращает SHA-256 нормализованного исходного события. */
export function inputHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Отвергает NUL и непарные суррогаты во всех ключах и значениях JSON. */
function representable(value: unknown, depth = 0): boolean {
 if(depth>64)return false;
 if (typeof value === 'number' && !Number.isFinite(value)) return false;
 if (typeof value === 'string') {
  if (value.includes(String.fromCharCode(0))) return false;
  for (const char of value) { const n = char.codePointAt(0)!; if (n >= 0xd800 && n <= 0xdfff) return false; }
 }
 if (Array.isArray(value)) return value.every(v=>representable(v,depth+1));
 if (value !== null && typeof value === 'object') return Object.entries(value).every(([k,v]) => representable(k,depth+1) && representable(v,depth+1));
 return true;
}
/** Разбирает ограниченный пакет; детали ошибки не раскрывают его содержимое. */
export function parseEvent(bytes: Uint8Array): Event {
 if (bytes.byteLength > 131072) throw new Fault('REQUEST_TOO_LARGE');
 let value: unknown;
 try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Fault('INVALID_ARGUMENT'); }
 if (!validate(value) || !representable(value)) throw new Fault('INVALID_ARGUMENT');
 return value as Event;
}

/** Проверяет read-запрос по той же опубликованной схеме без изменения данных. */
export function isGetRequest(value: unknown): boolean { return !!validateQuery(value) && representable(value); }

/** Проверяет устойчивый результат анализа/памяти и его связь с исходным материалом. */
export function isJobSuccess(packet: Packet, job: Job, result: Data): boolean {
 if(job.kind!=='understand' && job.kind!=='memory') return true;
 if(!(job.kind==='memory'?validateMemory(result):validateMaterial(result)) || !representable(result)) return false;
 const provenance=result.provenance as Data, original=packet.original.data;
 if(provenance.packetId!==packet.id || provenance.materialId!==original.materialId || provenance.revision!==original.revision || provenance.inputHash!==packet.inputHash) return false;
 if(job.kind==='memory') {
  const understood=Object.values(packet.jobs).find(j=>j.kind==='understand' && j.attempt===(packet.attempts.understand??0) && j.state==='succeeded');
  if(!understood || !isJobSuccess(packet,understood,understood.result??{}) || result.understandingRef!==understood.result?.resultRef) return false;
 }
 return true;
}
