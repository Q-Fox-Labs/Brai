// ABOUTME: Выполняет только операторскую миграцию и привязку персонального логина.
// ABOUTME: Принимает закрытый stdin; пароль owner поступает отдельным защищённым окружением.
import {Pool} from 'pg';
import {bindOwner,migrateIsolation} from './isolation.js';
try{
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>65536)throw new Error('INPUT_TOO_LARGE');}
 const request=JSON.parse(raw),owner=process.env.DIALOGUES_OWNER_ROLE,url=process.env.DIALOGUES_OWNER_DATABASE_URL;
 if(!owner||!url)throw new Error('OWNER_CONFIGURATION_REQUIRED');
 const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:3000,statement_timeout:30000});
 try{
  if(request.action==='migrate'&&Object.keys(request).length===1)await migrateIsolation(pool,owner);
  else if(request.action==='bind'&&Object.keys(request).sort().join(',')==='action,binding,login')await bindOwner(pool,owner,request.login,request.binding);
  else throw new Error('INVALID_OPERATION');
  process.stdout.write(JSON.stringify({ok:true})+'\n');
 }finally{await pool.end();}
}catch{process.stderr.write('DIALOGUES_ISOLATION_OPERATION_FAILED\n');process.exitCode=1;}
