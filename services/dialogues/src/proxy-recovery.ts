// ABOUTME: Определяет безопасный повтор запроса при потере MCP-сессии.
// ABOUTME: Не открывает сеть и не повторяет операцию при неизвестном исходе.

const readOnly = new Set<string>();
const unknownOutcome = {isError:true,content:[{type:'text' as const,text:'Исход записи не подтверждён. Сначала прочитайте актуальный ход, сообщение по исходному ID либо версию саммари. Повтор при неизвестном исходе не выполнялся.'}]};

/** Повторяет запрос один раз только после подтверждённого отказа до вызова операции. */
export async function callWithRecovery<T>(name:string,first:()=>Promise<T>,reconnect:()=>Promise<void>,retry:()=>Promise<T>,stale:(error:unknown)=>boolean):Promise<T|typeof unknownOutcome>{
 try{return await first();}
 catch(error){
  if(stale(error)){
   try{await reconnect();return await retry();}catch{/* Исход повторного вызова может быть неизвестен. */}
  } else if(readOnly.has(name))throw error;
  return unknownOutcome;
 }
}
