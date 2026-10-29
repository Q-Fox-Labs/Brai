// ABOUTME: Детерминированно продолжает сохранённые команды одной области Codeworks.
// ABOUTME: Сигналы только будят основной цикл; все данные и внешние действия принадлежат Activities.
const {proxyActivities,defineSignal,setHandler,condition,workflowInfo,continueAsNew,patched,allHandlersFinished,CancellationScope,ActivityCancellationType}=require('@temporalio/workflow');
const activities=proxyActivities({startToCloseTimeout:'10 seconds',scheduleToCloseTimeout:'1 minute',retry:{maximumAttempts:3,initialInterval:'1 second',maximumInterval:'5 seconds'}});
const execution=proxyActivities({startToCloseTimeout:'4 minutes',heartbeatTimeout:'10 seconds',scheduleToCloseTimeout:'15 minutes',retry:{maximumAttempts:3,initialInterval:'2 seconds',maximumInterval:'20 seconds'}});
const indexing=proxyActivities({startToCloseTimeout:'30 minutes',heartbeatTimeout:'10 seconds',retry:{maximumAttempts:1},cancellationType:ActivityCancellationType.WAIT_CANCELLATION_COMPLETED});
const finalization=proxyActivities({startToCloseTimeout:'35 minutes',heartbeatTimeout:'10 seconds',scheduleToCloseTimeout:'2 hours',retry:{maximumAttempts:3,initialInterval:'2 seconds',maximumInterval:'20 seconds'},cancellationType:ActivityCancellationType.WAIT_CANCELLATION_COMPLETED});
const wake=defineSignal('commandsAvailable');
/** Передаёт между runs только поколение и курсор; PostgreSQL хранит доказательства и окончательную дедупликацию. */
async function codeworksWorkspace(state={generation:1,position:0}) {
  patched('codeworks-ledger-v1');
  const continueAfter=Number.isSafeInteger(state.continueAfter)&&state.continueAfter>=2&&state.continueAfter<=500?state.continueAfter:500;
  let notified=true,cycles=0,delay=1000;
  let indexScope,indexPass,nextIndexAt=0;
  const stopIndex=async()=>{indexScope?.cancel();await indexPass;indexPass=undefined;indexScope=undefined;};
  setHandler(wake,()=>{notified=true;});
  const resilient=async work=>{for(;;){try{return await work();}catch{await condition(()=>false,30000);}}};
  for(;;){
    notified=false;
    const batch=await resilient(()=>activities.loadCommands(state.generation));
    if(batch.completed){await stopIndex();return;}
    if(patched('codeworks-checkpoint-references-v1'))state.checkpoint=batch.checkpoint;
    for(const command of batch.commands){
      if(['cleanup','workspace.cancel','workspace.transfer'].includes(command.kind))await stopIndex();
      try{
        if(patched('codeworks-scoped-activities-v1')&&command.kind){
          if(command.kind==='prepare'){
            const steps=[['prepareBranch','branch'],['prepareCheckout','checkout'],['prepareDependencies','dependencies'],['confirmWorkspace','ready']];
            for(const [name,stage] of steps){
              const result=await execution[name](command.operation_id,state.generation);
              if(result.status==='failed'||['branch','checkout','dependencies','ready'].indexOf(result.preparation_state)<['branch','checkout','dependencies','ready'].indexOf(stage))break;
            }
          }else{
            const names={sync:'synchronizeBranch',release:'advanceRelease',rollout:'reconcileRollout',cleanup:'cleanupWorkspace','release.close':'closeRelease','workspace.cancel':'cancelWorkspace','workspace.transfer':'transferWorkspace'};
            await execution[names[command.kind]](command.operation_id,state.generation);
          }
        }else await execution.executeCommand(command.operation_id,state.generation);
      }
      catch{await resilient(()=>activities.requireReconciliation(command.operation_id,state.generation));}
      state.position=Math.max(state.position,Number(command.sequence));
    }
    const immediate=patched('codeworks-cleanup-progress-v2');
    if(patched('codeworks-cleanup-obligations-v1')&&(batch.closing||(immediate&&batch.commands.some(command=>['release','cleanup','workspace.cancel','workspace.transfer'].includes(command.kind))))){
      await stopIndex();
      try{const result=await (immediate?finalization:execution).advanceCleanupObligation(state.generation);if(immediate&&result?.state==='pending')notified=true;}
      catch{await resilient(()=>activities.deferCleanupObligation(state.generation));}
    }
    if(await resilient(()=>activities.finishWorkflow(state.generation))){await stopIndex();return;}
    if((workflowInfo().continueAsNewSuggested||++cycles>=continueAfter)&&allHandlersFinished()&&!indexPass)await continueAsNew(state);
    if(patched('codeworks-worktree-index-v1')&&!indexPass&&Date.now()>=nextIndexAt){
      nextIndexAt=Date.now()+60000;indexScope=new CancellationScope();
      // AIDEV-NOTE: Не await: медленный embedding не задерживает чтение команд, sync и release.
      indexPass=indexScope.run(()=>indexing.maintainIndex(state.generation)).catch(()=>{}).finally(()=>{indexPass=undefined;indexScope=undefined;});
    }
    // AIDEV-NOTE: Уведомление не задаёт порядок; периодическое чтение восстанавливает потерянное пробуждение.
    delay=batch.commands.length?Math.min(delay*2,60000):60000;
    if(notified)delay=1000;
    await condition(()=>notified,delay);
  }
}
exports.codeworksWorkspace=codeworksWorkspace;
/** Singleton проекта регулярно сверяет сохранённые обязательства и продолжает историю. */
async function codeworksProjectReconciler(state){
  let cycles=0,previewPass,nextPreviewAt=0;
  for(;;){
    let progressed=false,historicalEnabled=false;
    if(patched('codeworks-web-preview-v1')&&!previewPass&&Date.now()>=nextPreviewAt){
      nextPreviewAt=Date.now()+60000;
      // AIDEV-NOTE: Публикация отдельно от очистки и не блокирует её длительным ожиданием.
      previewPass=execution.maintainPreviews(state.projectId,state.previewCursor??null).then(result=>{state.previewCursor=result?.cursor??null;}).catch(()=>{}).finally(()=>{previewPass=undefined;});
    }
    try{
      const cursorEnabled=patched('codeworks-reconciler-cursor-v1');
      const activity=(patched('codeworks-reconciler-progress-v2')?finalization:execution);
      historicalEnabled=patched('codeworks-historical-zero-cursor-v1');
      const result=historicalEnabled?await activity.reconcileProject(state.projectId,state.adoptionCursor??null,state.historicalCursor??null):cursorEnabled?await activity.reconcileProject(state.projectId,state.adoptionCursor??null):await activity.reconcileProject(state.projectId);
      if(cursorEnabled)state.adoptionCursor=result?.nextCursor??null;
      if(historicalEnabled)state.historicalCursor=result?.nextHistoricalCursor??null;
      progressed=result?.state==='pending'||(cursorEnabled&&result?.hasMore===true)||(historicalEnabled&&(result?.historicalHasMore===true||result?.ready===true));
    }catch{}
    const continueAfter=historicalEnabled&&Number.isSafeInteger(state.continueAfter)&&state.continueAfter>=2&&state.continueAfter<=500?state.continueAfter:500;
    if((workflowInfo().continueAsNewSuggested||++cycles>=continueAfter)&&allHandlersFinished()&&!previewPass)await continueAsNew(state);
    await condition(()=>false,progressed?1000:60000);
  }
}
exports.codeworksProjectReconciler=codeworksProjectReconciler;
