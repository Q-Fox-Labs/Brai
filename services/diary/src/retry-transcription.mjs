// ABOUTME: Запускает явно разрешённый операторский повтор ASR из защищённого runtime Diary.
// ABOUTME: Не выводит credentials, аудио или текст; проверяет конфигурацию до подключения.
import {readFile,lstat} from 'node:fs/promises';
import pg from 'pg';
import {connect} from 'nats';
import {createAdapters} from './adapters.mjs';
import {retryTranscription} from './recovery.mjs';
const [entryId,previousRequestId,retryId,mode]=process.argv.slice(2);
const path=process.env.DIARY_CONFIG,meta=await lstat(path);
if(!meta.isFile()||meta.uid!==0||meta.nlink!==1||(meta.mode&0o027))throw Error('UNSAFE_CONFIG');
const cfg=JSON.parse(await readFile(path,'utf8'));
const pool=new pg.Pool({connectionString:cfg.workerDatabaseUrl,max:1,connectionTimeoutMillis:3000,statement_timeout:10000});
let nc,c;
try{
 nc=await connect(cfg.nats);c=await pool.connect();
 console.log(JSON.stringify(await retryTranscription(c,createAdapters(cfg,nc),{entryId,previousRequestId,retryId,mode})));
}catch{
 console.error('DIARY_RETRY_REJECTED');process.exitCode=1;
}finally{
 c?.release();await nc?.drain();await pool.end();
}
