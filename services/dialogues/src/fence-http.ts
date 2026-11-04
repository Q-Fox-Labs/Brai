// ABOUTME: Передаёт MCP-запросы перехода с явно заданным разрешённым Host.
// ABOUTME: Применяется только к внутреннему соединению проверки готовности.
import http from 'node:http';

/** Native fetch подменяет Host, поэтому для внутреннего перехода используем node:http. */
export function hostFetch(host:string):typeof fetch {
 return (async (input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.protocol!=='http:')throw new Error('FENCE_HTTP_REQUIRED');
  const headers=new Headers(init?.headers);headers.set('host',host);
  const deadline=AbortSignal.timeout(5000),signal=init?.signal?AbortSignal.any([init.signal,deadline]):deadline;
  return await new Promise<Response>((resolve,reject)=>{
   const request=http.request(url,{method:init?.method??'GET',headers:Object.fromEntries(headers.entries()),signal},response=>{
    const chunks:Buffer[]=[];
    response.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    response.on('error',reject);
    response.on('end',()=>{
     const resultHeaders=new Headers();
     for(const [key,value] of Object.entries(response.headers))if(value!==undefined)
      for(const v of Array.isArray(value)?value:[value])resultHeaders.append(key,v);
     const status=response.statusCode??500,body=[204,205,304].includes(status)?null:Buffer.concat(chunks);
     resolve(new Response(body,{status,headers:resultHeaders}));
    });
   });
   request.on('error',reject);
   if(init?.body!==undefined&&init.body!==null){
    if(typeof init.body!=='string'&&!Buffer.isBuffer(init.body)&&!(init.body instanceof Uint8Array)){request.destroy(new Error('FENCE_BODY_INVALID'));return;}
    request.write(init.body);
   }
   request.end();
  });
 }) as typeof fetch;
}
