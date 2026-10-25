// ABOUTME: Передаёт отмену текущей Activity её внешним процессам без глобального состояния.
// ABOUTME: Контекст изолирован между параллельными Activities и не попадает в историю workflow.
import {AsyncLocalStorage} from 'node:async_hooks';
const execution=new AsyncLocalStorage();
/** Выполняет адаптеры с сигналом отмены только своего прохода. */
export const withExecutionContext=(context,work)=>execution.run(context,work);
/** Возвращает контекст Activity либо undefined для обычного CLI. */
export const executionContext=()=>execution.getStore();
/** Добавляет отмену Activity к собственному deadline HTTP-порта; вне Activity сохраняет обычный fetch. */
export function executionFetch(input,options={}){
  const signal=execution.getStore()?.signal;
  return fetch(input,{...options,...(signal?{signal:options.signal?AbortSignal.any([signal,options.signal]):signal}:{})});
}
