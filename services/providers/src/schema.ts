// ABOUTME: Проверяет JSON по закрытым Draft-07 схемам владельца providers.
// ABOUTME: Не изменяет вход и не удаляет неизвестные параметры.
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import type { Request, Upstream, Response } from "./core.js";
const schema = JSON.parse(readFileSync(new URL("../schemas/v0.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({allErrors: false, strict: true});
ajv.addFormat("date-time", {type:"string", validate(value: string) {
  const parsed=Date.parse(value);
  const date=value.slice(0,10),day=new Date(date+"T00:00:00Z");
  return Number.isFinite(parsed) && Number.isFinite(day.getTime()) && day.toISOString().slice(0,10)===date && !/T(?:2[4-9]|[3-9]\d):/.test(value);
}});
ajv.addSchema(schema, "v0");
export const validRequest = ajv.compile<Request>({$ref: "v0#/definitions/request"});
export const validUpstream = ajv.compile<Upstream>({$ref: "v0#/definitions/upstream"});
export const validResponse = ajv.compile<Response>({$ref: "v0#/definitions/response"});
