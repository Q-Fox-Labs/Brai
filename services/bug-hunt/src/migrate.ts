// ABOUTME: Выполняет миграции отдельной owner-ролью bug-hunt.
// ABOUTME: Runtime получает ограниченные DML-права и не запускает этот entrypoint.
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {Pool} from "pg";
const ident=(value:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new Error("INVALID_ROLE");return '"'+value+'"';};
/** Повторно применяет схему и ограниченные права без удаления существующих данных. */
export async function migrate(pool:Pool,ownerRole:string,appRole:string){
 if(ownerRole===appRole)throw new Error("DISTINCT_ROLES_REQUIRED");
 const owner=ident(ownerRole),app=ident(appRole),db=await pool.connect();
 try{
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(79001501)");
  const current=await db.query("SELECT current_user AS name");
  if(current.rows[0].name!==ownerRole)throw new Error("OWNER_ROLE_REQUIRED");
  const identity=(await db.query("SELECT current_database() AS name,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
  if(identity.owner!==ownerRole)throw new Error("DATABASE_OWNER_REQUIRED");
  const runtime=(await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=$1",[appRole])).rows[0];
  if(!runtime||Object.values(runtime).some(Boolean))throw new Error("UNSAFE_RUNTIME_ROLE");
  const database='"'+identity.name.replaceAll('"','""')+'"';
  await db.query("REVOKE ALL ON DATABASE "+database+" FROM PUBLIC");
  await db.query("REVOKE CREATE,TEMPORARY ON DATABASE "+database+" FROM "+app);
  await db.query("GRANT CONNECT ON DATABASE "+database+" TO "+app);
  for(const name of ["001.sql","002.sql","003.sql","004.sql"])await db.query(readFileSync(new URL("../migrations/"+name,import.meta.url),"utf8"));
  await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC,"+app);
  await db.query("GRANT USAGE ON SCHEMA public TO "+app);
  // AIDEV-NOTE: Не снимаем права будущих миграций при повторном запуске предыдущего migrator.
  const tables="sys_schema,bug_case,report,review,mutation,sys_capability,search_document,report_signature,observation_group,group_membership,grouping_decision,group_audit,similarity_proposal,classification,classification_override,v2_mutation";
  await db.query("REVOKE ALL ON "+tables+" FROM PUBLIC,"+app);
  await db.query("GRANT SELECT ON sys_schema,bug_case,report,review,mutation TO "+app);
  await db.query("GRANT INSERT ON bug_case,report,review,mutation TO "+app);
  await db.query("GRANT UPDATE(review_state,revision,updated_at) ON bug_case TO "+app);
  await db.query("GRANT SELECT ON sys_capability,search_document,report_signature,observation_group,group_membership,grouping_decision,group_audit,similarity_proposal,classification,classification_override,v2_mutation TO "+app);
  await db.query("GRANT INSERT ON search_document,report_signature,observation_group,group_membership,grouping_decision,group_audit,similarity_proposal,classification,classification_override,v2_mutation TO "+app);
  await db.query("GRANT UPDATE(revision,updated_at) ON observation_group TO "+app);
  await db.query("GRANT UPDATE(group_id,method,registered_at) ON group_membership TO "+app);
  await db.query("GRANT UPDATE(state) ON similarity_proposal TO "+app);
  await db.query("REVOKE ALL ON FUNCTION bug_hunt_proposal_limit() FROM PUBLIC");
  const processingTables="processing_job,processing_attempt,processing_budget,processing_control,processing_operator_action,embedding_chunk";
  await db.query("REVOKE ALL ON "+processingTables+" FROM PUBLIC,"+app);
  await db.query("GRANT SELECT,INSERT ON "+processingTables+" TO "+app);
  await db.query("GRANT UPDATE(state,lease_until,fence,available_at,technical_attempts,business_attempt_id,retry_reason,code,coverage,claimed_at,updated_at) ON processing_job TO "+app);
  await db.query("GRANT UPDATE(phase,result,usage,finished_at) ON processing_attempt TO "+app);
  await db.query("GRANT UPDATE(reserved_calls) ON processing_budget TO "+app);
  await db.query("GRANT UPDATE(paused,claim_counter,derivative_bytes,actor_id,reason,updated_at) ON processing_control TO "+app);
  const generationTables="embedding_generation,embedding_generation_control,embedding_generation_activation";
  await db.query("REVOKE ALL ON "+generationTables+" FROM PUBLIC,"+app);
  await db.query("GRANT SELECT,INSERT ON "+generationTables+" TO "+app);
  await db.query("GRANT UPDATE(active_generation,activation_revision,updated_at) ON embedding_generation_control TO "+app);
  await db.query("COMMIT");
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pool=new Pool({connectionString:process.env.BUG_HUNT_OWNER_DATABASE_URL,connectionTimeoutMillis:3000,max:1});
 try{if(!process.env.BUG_HUNT_OWNER_DATABASE_URL)throw new Error();await migrate(pool,process.env.BUG_HUNT_OWNER_ROLE??"",process.env.BUG_HUNT_APP_ROLE??"");}
 catch{console.error("BUG_HUNT_MIGRATION_FAILED");process.exitCode=1;}finally{await pool.end();}
}
