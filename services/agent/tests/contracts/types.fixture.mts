// ABOUTME: Проверяет импорт DTO пакета из позиции стороннего потребителя.
// ABOUTME: Все формы и AG-UI типы происходят из сгенерированных/upstream объявлений.
import { assertDto, validateDto, subjects, type TurnStartRequest, type ThreadSnapshot, validateUpstreamAnswer, type SupportedPendingRequest, type RequestRespondRequest } from '@brai/agent/contracts';

const request:TurnStartRequest={projectId:'demo',threadId:'opaque-thread',generation:'550e8400-e29b-41d4-a716-446655440000',operationId:'op-1',text:'hello'};
assertDto('TurnStartRequest',request);
if(validateDto('TurnStartRequest',request))request.text.toUpperCase();
const snapshot:ThreadSnapshot={projectId:'demo',threadId:'t',generation:request.generation,streamEpoch:request.generation,seq:0,state:'ready',messages:[],pendingRequests:[],truncation:{truncated:false,reason:'none'},activeTurnId:null,turnStatus:null,traceItems:[]};
snapshot.messages.map(message=>message.role);
subjects.turnStart satisfies string;

const pending:SupportedPendingRequest={requestId:'r',kind:'command-approval',params:{threadId:'t',turnId:'u',itemId:'i',startedAtMs:1,availableDecisions:['accept']}};
validateUpstreamAnswer(pending.kind,{decision:'accept'},pending.params);
const response:RequestRespondRequest={projectId:'demo',threadId:'t',generation:request.generation,operationId:'op-answer',requestId:'r',kind:'question',answer:{answers:{q:{answers:['A']}}}};
assertDto('RequestRespondRequest',response);
// @ts-expect-error Неизвестная форма ответа не относится к upstream-контракту.
const badResponse:RequestRespondRequest={...response,kind:'question',answer:{decision:'accept'}};
// @ts-expect-error Неподдерживаемый запрос не имеет параметров ответа.
validateUpstreamAnswer('unsupported',{},{});
void badResponse;

const phaseSnapshot:ThreadSnapshot={...snapshot,messagePhases:{m:'commentary',unknown:null}};
import type { CustomMessagePhase, CodexMessagePhase, Trace, CustomOutput, CodexCommandExecutionStatus } from '@brai/agent/contracts';
const phase:CodexMessagePhase='final_answer';
const phaseEvent:CustomMessagePhase={itemId:'m',phase};
const trace:Trace={type:'message',status:'completed',phase};
// @ts-expect-error Завершение хода не является фазой сообщения.
const invalidPhase:CustomMessagePhase={itemId:'m',phase:'success'};
void [phaseSnapshot,phaseEvent,trace,invalidPhase];

const commandStatus:CodexCommandExecutionStatus='declined';
const commandOutput:CustomOutput={itemId:'cmd',text:'output',command:'',status:commandStatus,exitCode:null};
// @ts-expect-error Допустимы только закреплённые статусы Codex.
const invalidCommandStatus:CustomOutput={itemId:'cmd',text:'output',command:'run',status:'exited'};
void [commandOutput,invalidCommandStatus];
