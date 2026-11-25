// ABOUTME: Проверяет закрытую готовность работающего координатора расшифровки.
// ABOUTME: Не вызывает модель и не выводит параметры доступа или содержимое ответа.
import http from 'node:http';

/** Возвращает ошибку при недоступности любой обязательной зависимости координатора. */
export async function verifyReadiness(env:NodeJS.ProcessEnv=process.env):Promise<void>{
  const binding=JSON.parse(env.TRANSCRIPTION_AUTH_BINDINGS_JSON??'[]')[0];
  const host=JSON.parse(env.TRANSCRIPTION_ALLOWED_HOSTS_JSON??'[]')[0];
  const port=Number(env.TRANSCRIPTION_HTTP_PORT);
  const maxBytes=Number(env.TRANSCRIPTION_HTTP_RESPONSE_BYTES);
  if(typeof binding?.token!=='string'||typeof host!=='string'||!Number.isInteger(port)||port<1||port>65535||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('TRANSCRIPTION_NOT_READY');
  const result=await new Promise<boolean>((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port,path:'/internal/readiness',method:'POST',timeout:10000,
      headers:{Host:host,Authorization:`Bearer ${binding.token}`,'Content-Type':'application/json'}},response=>{
      let raw='';response.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>maxBytes)request.destroy();});
      response.on('error',reject);
      response.on('end',()=>{try{const value=JSON.parse(raw);resolve(response.statusCode===200&&value?.ready===true);}catch{reject(new Error('TRANSCRIPTION_NOT_READY'));}});
    });
    request.on('error',reject);request.on('timeout',()=>request.destroy());request.end('{}');
  });
  if(!result)throw new Error('TRANSCRIPTION_NOT_READY');
}
