// ABOUTME: Догоняет пересчёт тем в подготовленном персональном профиле.
// ABOUTME: Пересчитывает производные данные и автоматически связывает продолжения одной задачи.
import {readFileSync} from 'node:fs';
import {Pool} from 'pg';
import {createSubscriptionLuna} from './subscription-luna.js';
import {createTopicJobs} from './topic-jobs.js';
import {verifyOwnerConnection} from './isolation.js';
import {connectAuthAccess} from './auth-access.js';
import {DialoguesFault} from './domain.js';

function required(name:string){
 const value=process.env[name]?.trim();
 if(!value)throw new DialoguesFault('TOPIC_BACKFILL_CONFIG_REQUIRED');
 return value;
}
let pool:Pool|undefined,luna:ReturnType<typeof createSubscriptionLuna>|undefined;
let access:Awaited<ReturnType<typeof connectAuthAccess>>|undefined;
try{
 const binding={ownerId:required('DIALOGUES_MCP_OWNER_ID'),userId:required('DIALOGUES_MCP_USER_ID'),
  profileId:required('DIALOGUES_MCP_PROFILE_ID')};
 pool=new Pool({connectionString:required('DIALOGUES_DATABASE_URL'),max:2});
 await verifyOwnerConnection(pool,binding);
 access=await connectAuthAccess(process.env,binding);
 luna=createSubscriptionLuna(JSON.parse(readFileSync(required('DIALOGUES_SUBSCRIPTION_CONFIG_FILE'),'utf8')));
 const jobs=createTopicJobs(pool,binding.ownerId,luna,access.authorize);
 const seeded=await jobs.seed();
 let operations=0;
 while(await jobs.tick({requireIdleWorker:true}))operations++;
 console.log(JSON.stringify({service:'dialogues',event:'topic_backfill_finished',seeded,operations}));
}catch(error){
 console.error(JSON.stringify({service:'dialogues',event:'topic_backfill_failed',code:error instanceof DialoguesFault?error.code:'INTERNAL'}));
 process.exitCode=1;
}finally{
 await luna?.close();await access?.close();await pool?.end();
}
