// ABOUTME: Определяет команды расследователя и формат результата.
// ABOUTME: Полномочия и состояние карточки проверяет сервер, а не модель.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {Fault, limits, validUnicode} from "./contracts.js";

const uuid = {type: "string", format: "uuid"};
const text = {type: "string", minLength: 1, pattern: "\\S"};
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
 type: "object", properties, required, additionalProperties: false,
});

export const resultSchema = object({
 verdict: {enum: ["confirmed", "expected_behavior", "fixed", "insufficient_evidence"]},
 description: text,
 evidence: {type: "array", items: object({source: text, observed_at: {type: "string", format: "date-time"}, fact: text})},
 scope: object({component_version: text, commit_sha: text, deployment_revision: text}, []),
 advice: object({kind: {enum: ["correct_path", "workaround", "stop"]}, text}),
}, ["verdict", "description", "evidence", "scope"]);

export const investigationSchemas = {
 claim: object({request_id: uuid, case_id: uuid, component: {enum:["agent","hermes"]}}, ["request_id"]),
 complete: object({request_id: uuid, investigation_id: uuid, result: resultSchema}),
 fail: object({request_id: uuid, investigation_id: uuid}),
};

export type DiagnosticResult = {
 verdict: "confirmed" | "expected_behavior" | "fixed" | "insufficient_evidence";
 description: string;
 evidence: {source: string; observed_at: string; fact: string}[];
 scope: Partial<Record<"component_version" | "commit_sha" | "deployment_revision", string>>;
 advice?: {kind: "correct_path" | "workaround" | "stop"; text: string};
};
export type Claim = {request_id: string; case_id?: string; component?: "agent"|"hermes"};
export type Complete = {request_id: string; investigation_id: string; result: DiagnosticResult};
export type Fail = {request_id: string; investigation_id: string};

const ajv = new Ajv.default();
addFormats.default(ajv);
const validators = {
 claim: ajv.compile(investigationSchemas.claim),
 complete: ajv.compile(investigationSchemas.complete),
 fail: ajv.compile(investigationSchemas.fail),
};

/** Validates one command before any database access. */
export function validateInvestigation(operation: keyof typeof validators, input: unknown): void {
 const raw = JSON.stringify(input);
 if (!raw || Buffer.byteLength(raw) > limits.requestBytes) throw new Fault("REQUEST_TOO_LARGE");
 if (!validUnicode(input) || !validators[operation](input)) throw new Fault("INVALID_ARGUMENT");
 if (operation === "complete") {
  const {result} = input as Complete;
  if (result.verdict !== "insufficient_evidence" && (!result.evidence.length ||
    !Object.values(result.scope).some(value => value.trim().toLowerCase() !== "unknown"))) {
   throw new Fault("INVALID_ARGUMENT");
  }
 }
}
