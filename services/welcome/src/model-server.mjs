// ABOUTME: Владеет отдельной подписочной сессией Welcome и выполняет один inference за раз.
// ABOUTME: Вход принимает только форму Welcome на Unix-сокете без команд и инструментов.
import {chmod,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {welcomeLocalModel} from './model.mjs';
import {readModelMessage} from './model-port.mjs';

const config=JSON.parse(await readFile(process.env.WELCOME_MODEL_CONFIG,'utf8'));
const location=config.socketPath;
if(!/^\/run\/brai-welcome-model-[a-z0-9-]+\/model\.sock$/.test(location))throw Error('WELCOME_MODEL_SOCKET');
const model=await welcomeLocalModel(config);
let previous=Promise.resolve();
const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'||!['/catalog','/turn'].includes(req.url)){res.writeHead(404).end();return;}
  const input=await readModelMessage(req);
  const execute=previous.then(()=>req.url==='/catalog'?model.catalog():model.respond(input));
  previous=execute.then(()=>{},()=>{});
  const result=await execute;
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
 }catch{
  res.writeHead(503,{'content-type':'application/json'}).end('{"error":"WELCOME_MODEL_UNAVAILABLE"}');
 }
});
await new Promise((resolve,reject)=>server.once('error',reject).listen(location,resolve));
await chmod(location,0o660);
