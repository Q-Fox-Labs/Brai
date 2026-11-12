// ABOUTME: Определяет безопасные предметные ошибки Codeworks.
// ABOUTME: SQL, команды и секреты не передаются через публичные ответы.
export const errorStatus = {
  INVALID_ARGUMENT: 400, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409,
  OWNERSHIP_CONFLICT: 409, DEPENDENCIES_INCOMPATIBLE: 422,
  WORKSPACE_WRITE_REQUIRED: 409, WRITE_CALL_MISMATCH: 409, PREPARE_PENDING: 409,
  WRITER_OUTCOME_UNKNOWN: 409, CLEANUP_ALREADY_STARTED: 409, TRANSFER_UNVERIFIED: 409,
  WORKSPACE_KIND_CONFLICT: 409, PR_IDENTITY_CONFLICT: 409, PR_AMBIGUOUS: 409, PR_HEAD_PENDING: 409, PR_HEAD_UNCONFIRMED: 409, PR_CREATE_UNCERTAIN: 409,
  GITHUB_RATE_LIMITED: 429, GITHUB_AUTH_REQUIRED: 401, CI_PROOF_INVALID: 409,
  GIT_FAILED: 422, GITHUB_UNAVAILABLE: 503, CHECKS_BLOCKED: 409, TARGET_CHANGED: 409, MERGE_CONFLICT: 409, PRODUCTION_BASE_MISMATCH: 409, BUSY: 503, INTERNAL: 500,
};
/** Ошибка границы с безопасной причиной; не принимает stderr внешних программ. */
export class Fault extends Error {
  constructor(code, message = code) { super(message); this.name = 'CodeworksFault'; this.code = code; }
  /** Возвращает DTO, пригодный для обоих транспортов. */
  dto() {
    const retryable=['BUSY','GITHUB_RATE_LIMITED','GITHUB_UNAVAILABLE'].includes(this.code);
    const retryAt=typeof this.retryAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(this.retryAt)&&Number.isFinite(Date.parse(this.retryAt))?new Date(this.retryAt).toISOString():null;
    return {code:this.code,message:this.message,retryable,...(retryable&&retryAt?{retry_at:retryAt}:{})};
  }
}
/** Скрывает непредвиденные инфраструктурные сообщения от вызывающей стороны. */
export function safeFault(error) { return error instanceof Fault ? error : new Fault('INTERNAL'); }

/** Различает отказы HTTP без публикации тела ответа, credentials и stderr. */
export function githubFailure({status,headers={},body='',now=Date.now()}={}) {
  const header=name=>headers.get?.(name)??headers[name]??headers[name.toLowerCase()];
  const retry=header('retry-after'),reset=Number(header('x-ratelimit-reset'))*1000;
  if(status===429||(status===403&&(header('x-ratelimit-remaining')==='0'||retry||/rate limit|secondary rate|abuse detection/i.test(body)))) {
    const seconds=retry!==null&&retry!==undefined&&/^\d+(?:\.\d+)?$/.test(String(retry))?Number(retry)*1000:NaN;
    const date=Number.isFinite(seconds)?now+seconds:Date.parse(retry);
    const fault=new Fault('GITHUB_RATE_LIMITED');
    fault.retryAt=new Date(Math.max(now+1000,Number.isFinite(date)?date:Number.isFinite(reset)&&reset>now?reset:now+60000)).toISOString();
    return fault;
  }
  if(status===401||status===403)return new Fault('GITHUB_AUTH_REQUIRED');
  return new Fault('GITHUB_UNAVAILABLE');
}

/** Отличает повреждённые и конфликтующие доказательства от недоступного транспорта. */
export function ciFailure(error) {
  if(error instanceof Fault)return error.code==='GIT_FAILED'?new Fault('GITHUB_UNAVAILABLE'):error;
  if(error instanceof SyntaxError)return new Fault('CI_PROOF_INVALID');
  return new Fault(/^(?:CI_.*(?:INVALID|MISMATCH|CONFLICT|MISSING)|REGISTRY_.*(?:INVALID|MISMATCH)|COMPOSITION_.*(?:INVALID|MISSING|DUPLICATE))/u.test(error?.message??'')?'CI_PROOF_INVALID':'GITHUB_UNAVAILABLE');
}
