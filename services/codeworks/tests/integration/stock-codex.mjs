// ABOUTME: Запускает неизменённый Codex с отдельным home и локальным детерминированным Responses fixture.
// ABOUTME: Не читает auth, не вызывает настоящую модель и не подключает рабочие чаты пользователя.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import WebSocket from 'ws';

/** Создаёт только изолированный тестовый исполнитель; владелец обязан вызвать close. */
export async function stockCodex({binary,home,cwd,command,hookCommand,socketPath}) {
  await mkdir(home,{mode:0o700});let requests=0,tools=[],nextScript=command?`text(await tools.exec_command(${JSON.stringify({cmd:command,workdir:cwd,sandbox_permissions:'require_escalated',justification:'Isolated Codeworks fixture'})}));`:null;const requestShapes=[];
  const http=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const input=JSON.parse(body);tools=input.tools??tools;requests++;requestShapes.push({url:req.url,keys:Object.keys(input),tools:input.tools?.map(t=>({type:t.type,name:t.name,keys:Object.keys(t)}))});
    const message={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture complete.'}]};
    const shell=tools.find(t=>t.type==='function'&&['exec_command','shell_command','shell'].includes(t.name));
    const exec=tools.find(t=>t.type==='custom'&&t.name==='exec');
    let item=message;
    if(nextScript){item={type:'custom_tool_call',id:'ct_fixture_'+requests,call_id:'call_fixture_'+requests,name:exec?.name??'exec',input:nextScript};nextScript=null;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{id:'resp_'+requests,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_'+requests,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  await writeFile(home+'/config.toml',`model="gpt-6.1-sol"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Codeworks fixture"\nbase_url="http://127.0.0.1:${http.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,{mode:0o600});
  if(hookCommand)await writeFile(home+'/hooks.json',JSON.stringify({hooks:{PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:hookCommand}]}]}}),{mode:0o600});
  if(socketPath)await mkdir(home+'/control',{mode:0o700});
  const child=spawn(binary,['app-server','--listen',socketPath?'unix://'+socketPath:'stdio://'],{cwd,env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
  const pending=new Map(),events=[];let seq=0,ws;
  if(socketPath){for(let i=0;!await stat(socketPath).catch(()=>null);i++){if(i>100)throw Error('STOCK_SOCKET_TIMEOUT '+stderr);await new Promise(r=>setTimeout(r,50));}ws=new WebSocket('ws+unix://'+socketPath+':/');await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});}
  const send=m=>ws?ws.send(JSON.stringify(m)):child.stdin.write(JSON.stringify(m)+'\n');
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({method,id,params});});
  const receive=line=>{
    const m=JSON.parse(String(line));events.push(m);
    if(m.method?.endsWith('/requestApproval'))send({id:m.id,result:{decision:'accept'}});
    else if(m.id!==undefined){const entry=pending.get(m.id);if(entry){pending.delete(m.id);m.error?entry.reject(Error(JSON.stringify(m.error))):entry.resolve(m.result);}}
  };
  if(ws)ws.on('message',receive);else createInterface({input:child.stdout}).on('line',receive);
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error('STOCK_CODEX_EXIT '+stderr));pending.clear();});
  await call('initialize',{clientInfo:{name:'codeworks_stock_fixture',version:'1'},capabilities:{experimentalApi:true}});
  send({method:'initialized',params:{}});
  return {call,events,requestShapes,setScript(script){nextScript=script;},get tools(){return tools;},get stderr(){return stderr;},async close(){ws?.close();child.stdin.end();if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}};
}
