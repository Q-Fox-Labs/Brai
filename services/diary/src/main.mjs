// ABOUTME: Собирает собственный сервис Дневника и его серверный worker.
// ABOUTME: Браузерный запрос не владеет жизненным циклом принятого задания.
import {readFile,lstat} from 'node:fs/promises';
import pg from 'pg';
import {connect} from 'nats';
import {createStore} from './store.mjs';
import {createAdapters} from './adapters.mjs';
import {createDiaryServer} from './http.mjs';
import {advance} from './domain.mjs';
const path=process.env.DIARY_CONFIG,meta=await lstat(path);
if(!meta.isFile()||meta.uid!==0||meta.nlink!==1||(meta.mode&0o027))throw Error('UNSAFE_CONFIG');
const cfg=JSON.parse(await readFile(path,'utf8'));
const app=new pg.Pool({connectionString:cfg.appDatabaseUrl,max:4,connectionTimeoutMillis:3000,statement_timeout:10000});
const worker=new pg.Pool({connectionString:cfg.workerDatabaseUrl,max:2,connectionTimeoutMillis:3000,statement_timeout:10000});
const nc=await connect(cfg.nats),store=createStore(app,worker),ports=createAdapters(cfg,nc);
await app.query('SELECT 1 FROM diary.entries LIMIT 0');
const server=createDiaryServer(cfg,store,ports);
await new Promise(resolve=>server.listen(cfg.port,cfg.host,resolve));
let stopped=false,busy=false;
const tick=async()=>{if(stopped||busy)return;busy=true;try{await store.next(async(e,save)=>{await ports.active(e.ownerId,e.profileId);await advance(e,ports,save);});}catch{console.error('DIARY_WORKER_UNAVAILABLE');}finally{busy=false;}};
const timer=setInterval(tick,2000);void tick();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopped)return;stopped=true;clearInterval(timer);server.close();while(busy)await new Promise(r=>setTimeout(r,100));await nc.drain();await Promise.all([app.end(),worker.end()]);});
console.log('DIARY_READY');
