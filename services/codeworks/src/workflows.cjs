// ABOUTME: Детерминированно продолжает сохранённые команды одной области Codeworks.
// ABOUTME: Сигналы только будят основной цикл; все данные и внешние действия принадлежат Activities.
const {proxyActivities,defineSignal,setHandler,condition,workflowInfo,continueAsNew,patched,allHandlersFinished}=require('@temporalio/workflow');
const activities=proxyActivities({startToCloseTimeout:'10 seconds',scheduleToCloseTimeout:'1 minute',retry:{maximumAttempts:3,initialInterval:'1 second',maximumInterval:'5 seconds'}});
const execution=proxyActivities({startToCloseTimeout:'4 minutes',heartbeatTimeout:'10 seconds',scheduleToCloseTimeout:'15 minutes',retry:{maximumAttempts:3,initialInterval:'2 seconds',maximumInterval:'20 seconds'}});
const wake=defineSignal('commandsAvailable');
/** Передаёт между runs только поколение и курсор; PostgreSQL хранит доказательства и окончательную дедупликацию. */
async function codeworksWorkspace(state={generation:1,position:0}) {
  patched('codeworks-ledger-v1');
  const continueAfter=Number.isSafeInteger(state.continueAfter)&&state.continueAfter>=2&&state.continueAfter<=500?state.continueAfter:500;
  let notified=true,cycles=0,delay=1000;
  setHandler(wake,()=>{notified=true;});
  const resilient=async work=>{for(;;){try{return await work();}catch{await condition(()=>false,30000);}}};
  for(;;){
    notified=false;
    const batch=await resilient(()=>activities.loadCommands(state.generation));
    if(batch.completed)return;
    if(patched('codeworks-checkpoint-references-v1'))state.checkpoint=batch.checkpoint;
    for(const command of batch.commands){
      try{
        if(patched('codeworks-scoped-activities-v1')&&command.kind){
          if(command.kind==='prepare'){
            const steps=[['prepareBranch','branch'],['prepareCheckout','checkout'],['prepareDependencies','dependencies'],['confirmWorkspace','ready']];
            for(const [name,stage] of steps){
              const result=await execution[name](command.operation_id,state.generation);
              if(result.status==='failed'||['branch','checkout','dependencies','ready'].indexOf(result.preparation_state)<['branch','checkout','dependencies','ready'].indexOf(stage))break;
            }
          }else{
            const names={sync:'synchronizeBranch',release:'advanceRelease',rollout:'reconcileRollout',cleanup:'cleanupWorkspace','release.close':'closeRelease','workspace.cancel':'cancelWorkspace'};
            await execution[names[command.kind]](command.operation_id,state.generation);
          }
        }else await execution.executeCommand(command.operation_id,state.generation);
      }
      catch{await resilient(()=>activities.requireReconciliation(command.operation_id,state.generation));}
      state.position=Math.max(state.position,Number(command.sequence));
    }
    if(await resilient(()=>activities.finishWorkflow(state.generation)))return;
    if((workflowInfo().continueAsNewSuggested||++cycles>=continueAfter)&&allHandlersFinished())await continueAsNew(state);
    // AIDEV-NOTE: Уведомление не задаёт порядок; периодическое чтение восстанавливает потерянное пробуждение.
    delay=batch.commands.length?Math.min(delay*2,60000):60000;
    if(notified)delay=1000;
    await condition(()=>notified,delay);
  }
}
exports.codeworksWorkspace=codeworksWorkspace;
