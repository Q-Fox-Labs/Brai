// ABOUTME: Загружает явные привязки источников и адреса необходимых операций.
// ABOUTME: Не читает .env, не выводит credentials и не включает синтетический fallback.
import { readFileSync } from 'node:fs';
import type { Binding, PortConfig, PortName } from './types.js';
export interface Config {
 databaseUrl: string; natsUrl: string; natsOptionsFile?: string;
 temporalAddress: string; temporalNamespace: string; taskQueue: string;
 sources: Record<string,Binding>; ports: Record<PortName,PortConfig>;
 artifactBaseUrl: string;
}
const names: PortName[] = ['channel','contact','inbox','hermes','understand','memory','deliver'];
/** Проверяет минимальный runtime config до сетевых соединений. */
export function validateConfig(value: unknown): Config {
 const c = value as Config;
 if (!c || typeof c !== 'object' || !c.databaseUrl || !c.natsUrl || !c.temporalAddress || !c.temporalNamespace || !c.taskQueue || !c.sources || !c.ports) throw Error('INVALID_CONFIG');
 for (const [source,b] of Object.entries(c.sources)) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(source) || typeof b.ownerId !== 'string' || !b.ownerId || b.ownerId.length>255 || !Array.isArray(b.types) || !Array.isArray(b.recipients) || typeof b.read !== 'boolean' || typeof b.resume !== 'boolean') throw Error('INVALID_SOURCE_BINDING');
  if (b.recipients.some(r=> !/^[a-z][a-z0-9_]{0,63}$/.test(r))) throw Error('INVALID_RECIPIENT');
  if (b.fileBaseUrl && !['http:','https:'].includes(new URL(b.fileBaseUrl).protocol)) throw Error('INVALID_FILE_ORIGIN');
 }
 for (const name of names) {
  const p = c.ports[name];
  if (!p || !/^brai\.[a-zA-Z0-9_.-]+$/.test(p.subject) || /[*>]/.test(p.subject)) throw Error('INVALID_PORT');
  if (['hermes','understand','memory','deliver'].includes(name) && (!p.resultSource || !c.sources[p.resultSource]?.types.includes('operation.result'))) throw Error('INVALID_RESULT_SOURCE');
 }
 if (!c.artifactBaseUrl || !['http:','https:'].includes(new URL(c.artifactBaseUrl).protocol)) throw Error('INVALID_ARTIFACT_ORIGIN');
 return c;
}
/** Читает только явно заданный защищённый файл конфигурации. */
export function loadConfig(): Config {
 const file = process.env.INTAKE_CONFIG;
 if (!file) throw Error('MISSING_INTAKE_CONFIG');
 return validateConfig(JSON.parse(readFileSync(file,'utf8')));
}
