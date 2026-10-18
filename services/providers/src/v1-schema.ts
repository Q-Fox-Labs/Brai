// ABOUTME: Проверяет закрытые DTO v1 и фактические типы ответов Jev.
// ABOUTME: Ограничение глубины/байтов выполняется до AJV на входной границе.
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import type { DecideRequest, DecideUpstream } from "./operations.js";
const ajv=new Ajv({strict:true});
ajv.addFormat("date-time",{type:"string",validate(value:string){const date=value.slice(0,10),day=new Date(date+"T00:00:00Z");return Number.isFinite(Date.parse(value)) && Number.isFinite(day.getTime()) && day.toISOString().slice(0,10)===date && !/T(?:2[4-9]|[3-9]\d):/.test(value);}});
ajv.addSchema(JSON.parse(readFileSync(new URL("../schemas/v1.schema.json",import.meta.url),"utf8")),"v1");
/** Компилирует ссылку на принадлежащий сервису DTO без копии схемы. */
export function v1Validator(name:string){return ajv.compile({$ref:`v1#/definitions/${name}`});}
export const validChatResult=ajv.compile({$ref:"v1#/definitions/chatResult"});
export const validChatRequest=ajv.compile({$ref:"v1#/definitions/chatRequest"});
export const validDecideRequest=ajv.compile<DecideRequest>({$ref:"v1#/definitions/decideRequest"});
export const validDecideUpstream=ajv.compile<DecideUpstream>({$ref:"v1#/definitions/decideUpstream"});

export const validImageRequest=ajv.compile({$ref:"v1#/definitions/imageRequest"});
