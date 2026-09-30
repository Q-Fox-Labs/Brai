// ABOUTME: Проверяет сообщения на NATS-границе по контракту владельца auth.
// ABOUTME: Не изменяет данные и не раскрывает входной пакет в ошибках.
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
const schema=JSON.parse(readFileSync(new URL("../schemas/messages.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv({strict:true,allErrors:false});ajv.addSchema(schema);
const checks=new Map<string,ReturnType<typeof ajv.compile>>();
/** Проверяет named DTO; при нарушении контракта бросает безопасную ошибку. */
export function validate(name:string,value:unknown){let check=checks.get(name);if(!check){check=ajv.compile({$ref:`${schema.$id}#/definitions/${name}`});checks.set(name,check);}if(!check(value))throw new Error("Invalid request");}
