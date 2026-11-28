// ABOUTME: Запускает отдельный защищённый процесс Welcome.
// ABOUTME: Принимает обновления только от Telegram-входа, проверяет Auth для чтения и записи админки.
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import {welcomeAdmin} from './admin.mjs';
import {mediaPorts} from './media.mjs';
import {welcomeModel} from './model.mjs';
import {authPort,dialoguesPort,messaging} from './ports.mjs';
import {createWelcome} from './service.mjs';

const config=JSON.parse(await readFile(process.env.WELCOME_CONFIG,'utf8'));
const secret=Buffer.from('Bearer '+(await readFile(config.ingressSecret,'utf8')).trim());
const grant=(await readFile(config.dialoguesGrant,'utf8')).trim();
if(secret.length<39||grant.length<32||!/^[A-Za-z0-9_]{5,32}$/.test(config.botName))throw Error('WELCOME_CONFIG');
const pool=new pg.Pool({connectionString:config.databaseURL});
const bus=await messaging(config.nats);
const auth=authPort(bus);
const model=await welcomeModel(config.codex);
const media=mediaPorts(bus,config.media);
const welcome=createWelcome({pool,auth,model,botName:config.botName,dialogues:dialoguesPort({origin:config.dialoguesOrigin,token:grant}),...media});
const admin=welcomeAdmin(pool,auth,model);
const telegram=/^[1-9][0-9]{0,19}$/u;

function validEvent(body){
 return ['text','file','audio','callback','pending'].includes(body?.kind)
  && [body.botId,body.telegramId].every(id=>typeof id==='string'&&telegram.test(id))
  && typeof body.updateId==='string'&&/^[0-9]+$/.test(body.updateId)
  && (body.threadId===undefined||telegram.test(body.threadId))
  && (body.avatarFileId===undefined||typeof body.avatarFileId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(body.avatarFileId))
  && typeof body.name==='string'&&Array.from(body.name).length<=200;
}
async function readBody(request,limit) {
 const blocks=[];let size=0;
 for await(const block of request){
  size+=block.length;
  if(size>limit)throw Object.assign(Error('BODY_TOO_LARGE'),{status:413});
  blocks.push(block);
 }
 return Buffer.concat(blocks);
}
async function json(request) {
 const raw=await readBody(request,2*1024*1024);
 try{return JSON.parse(raw.toString());}
 catch{throw Object.assign(Error('INVALID_JSON'),{status:400});}
}
const server=createServer(async (req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/health'){
   await pool.query('SELECT 1 FROM welcome.settings LIMIT 1');
   res.writeHead(200).end('ok');return;
  }
  const target=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&target.pathname==='/media'||req.method==='POST'&&['/telegram','/telegram-audio'].includes(req.url)){
   const raw=Buffer.from(req.headers.authorization??'');
   if(raw.length!==secret.length||!timingSafeEqual(raw,secret)){res.writeHead(401).end();return;}
   if(req.method==='GET'){
    const user=await auth.resolve(target.searchParams.get('telegramId'));
    const id=target.searchParams.get('artifactId');
    if(!user||!/^[0-9a-f-]{36}$/.test(id??'')){res.writeHead(404).end();return;}
    const recorded=await pool.query(`SELECT 1 FROM welcome.turns WHERE user_id=$1
     AND (result->>'image'=$2 OR (result->'audio') ? $2) LIMIT 1`,[user.id,id]);
    if(!recorded.rowCount){res.writeHead(404).end();return;}
    const file=await media.artifact(user.id,id);
    res.writeHead(200,{'content-type':file.headers.get('content-type')??'application/octet-stream'});
    Readable.fromWeb(file.body).on('error',()=>res.destroy()).pipe(res);
    return;
   }
   const audio=req.url==='/telegram-audio';
   let body;
   if(audio){
    try{body=JSON.parse(Buffer.from(String(req.headers['x-brai-welcome-event']??''),'base64url').toString());}
    catch{res.writeHead(400).end();return;}
   }else body=await json(req);
   if(!validEvent(body)||audio&&body.kind!=='audio'){res.writeHead(400).end();return;}
   delete body.audioBytes;
   if(audio)body.audioBytes=await readBody(req,config.telegramAudioBytes);
   const result=await welcome.handle(body);
   res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
   return;
  }
  if(req.method!=='POST'||req.url!=='/admin'){res.writeHead(404).end();return;}
  const origin=req.headers.origin;
  if(!config.adminOrigins.includes(origin)){res.writeHead(403).end();return;}
  const body=await json(req);
  const result=await admin(body.operation,body.input??{},{origin,cookie:req.headers.cookie??''});
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(result));
 }catch(error){
  if(!res.headersSent)res.writeHead(error.status??503,{'content-type':'application/json'});
  res.end(JSON.stringify({error:error.status?error.message:'WELCOME_UNAVAILABLE'}));
  if(!error.status)console.error(JSON.stringify({service:'welcome',error:'DEPENDENCY_OR_STORAGE'}));
 }
});
await new Promise((resolve,reject)=>server.once('error',reject).listen(config.port,config.host,resolve));
for(const event of ['SIGTERM','SIGINT'])process.once(event,async()=>{
 server.closeAllConnections();
 await new Promise(resolve=>server.close(resolve));
 await Promise.all([pool.end(),bus.close()]);
});
