// ABOUTME: Загружает единственный owner-набор схем обоих адаптеров Codeworks.
// ABOUTME: Ядро принимает только проверенные именованные параметры; лишние поля запрещены.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { Fault } from './errors.mjs';
export const schema = JSON.parse(readFileSync(new URL('../schemas/api.schema.json', import.meta.url),'utf8'));
export const methods = ['project.register','project.get','prepare-write','status','attach-or-transfer','commit','request-release','operation-status'];
export const outputNames = { 'project.register':'projectResponse','project.get':'projectResponse','prepare-write':'accepted','status':'statusResponse','attach-or-transfer':'accepted','commit':'accepted','request-release':'accepted','operation-status':'operationResponse' };
const ajv = new Ajv({allErrors:false});
ajv.addSchema(schema,'owner');
const validators=Object.fromEntries(Object.keys(schema.definitions).map(name=>[name,ajv.compile({$ref:'owner#/definitions/'+name})]));
/** Проверяет фактический DTO по owner схеме; ошибки не раскрывают входные данные. */
export function validate(name,value) { if (!validators[name]?.(value)) throw new Fault('INVALID_ARGUMENT'); return value; }
/** Раскрывает локальные ссылки для схем MCP без дублирования owner-определений. */
export function expanded(name) {
  const visit=value=>Array.isArray(value)?value.map(visit):value&&typeof value==='object'?value.$ref?visit(schema.definitions[value.$ref.split('/').at(-1)]):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)])):value;
  return visit(schema.definitions[name]);
}
/** Канонические JSON байты не зависят от порядка ключей объекта. */
export function canonical(value) { return JSON.stringify(sort(value)); }
function sort(v) { return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v; }
