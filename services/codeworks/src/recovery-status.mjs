// ABOUTME: Готовит безопасную подсказку восстановления без запуска операторских команд.
// ABOUTME: Завершённые задачи не получают устаревшие блокировки; причины не содержат внешних ответов.
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(value)?value:'RECOVERY_REQUIRED';
const at=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():null;
const hint=(category,reason,retry,action)=>({category,code:code(reason),retry_at:at(retry),action});
/** Выбирает подсказку по подтверждённым состояниям; она не является разрешением ремонта. */
export function recoveryStatus({workspace,workflow,obligation,writerBlocked=false,operation,control,postprocessing,retryAt,now=Date.now()}={}){
  if(workspace?.removed_at||workflow?.state==='completed'||operation?.status==='succeeded'&&obligation?.state==='done')return null;
  if(writerBlocked||obligation?.blocker==='WRITER_OUTCOME_UNKNOWN')return hint('unknown_outcome','WRITER_OUTCOME_UNKNOWN',null,'inspect_outcome');
  if(postprocessing)return hint('decision',postprocessing.code??'RUNBOOK_POSTPROCESSING_FAILED',null,'postprocess-repair');
  if(obligation?.state==='waiting_decision'){
    const resumable=['OWNERSHIP_CONFLICT','DIRTY_WORKTREE'].includes(obligation.blocker);
    return hint('decision',obligation.blocker,null,resumable?'cleanup-resume':'review_evidence');
  }
  if(control?.github_retry_at&&new Date(control.github_retry_at).getTime()>now)return hint('quota',control.github_reason_code??'GITHUB_RATE_LIMITED',control.github_retry_at,'wait_for_quota');
  if(obligation?.state==='retry')return hint('transient',obligation.blocker??'TECHNICAL_RETRY',obligation.next_attempt_at,'retry');
  const reason=operation?.error?.code??operation?.result?.reason??operation?.step;
  if(['GITHUB_AUTH_REQUIRED','CI_PROOF_INVALID'].includes(reason))return hint('decision',reason,null,'review_evidence');
  if(['GITHUB_UNAVAILABLE','CI_VERIFICATION_UNAVAILABLE','TECHNICAL_RETRIES_EXHAUSTED'].includes(reason))return hint('transient',reason,retryAt,'retry');
  if(workflow?.executor_state==='unavailable')return hint('unknown_outcome','EXECUTOR_UNAVAILABLE',null,'inspect_outcome');
  return null;
}
