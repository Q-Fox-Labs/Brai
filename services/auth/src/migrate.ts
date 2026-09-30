// ABOUTME: Применяет штатный план миграций Better Auth и минимальные runtime права.
// ABOUTME: Проверяет отдельные owner/app роли до любого изменения собственной БД.
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { config } from "./config.js";
import { createAuth } from "./auth.js";
const cfg=config(process.env,"migration");const pool=new Pool({connectionString:cfg.databaseURL,connectionTimeoutMillis:5000});
try {
 const owner=process.env.AUTH_OWNER_ROLE,role=process.env.AUTH_APP_ROLE;
 if(!owner||!role||owner===role||![owner,role].every(name=>/^[a-z_][a-z0-9_]*$/.test(name)))throw new Error("Separate owner/app roles required");
 const identity=(await pool.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
 if(identity.role!==owner||identity.owner!==owner)throw new Error("Migration requires database owner");
 const runtime=(await pool.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=$1",[role])).rows[0];
 if(!runtime||Object.values(runtime).some(Boolean))throw new Error("Unsafe runtime role");
 const auth=createAuth(cfg,pool,async()=>{throw new Error("Email disabled in migration");});
 const plan=await getMigrations(auth.options);if(plan.schemaProblems.length)throw new Error("Invalid schema");await plan.runMigrations();
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 await pool.query(`REVOKE ALL ON DATABASE ${quote(identity.db)} FROM PUBLIC`);
 await pool.query(`REVOKE CREATE ON DATABASE ${quote(identity.db)} FROM ${quote(role)}`);
 await pool.query(`GRANT CONNECT ON DATABASE ${quote(identity.db)} TO ${quote(role)}`);
 await pool.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
 await pool.query(`REVOKE ALL ON SCHEMA public FROM ${quote(role)}`);
 await pool.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
 await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,${quote(role)}`);
 await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quote(role)}`);
 await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)}`);
 console.log("auth migrations complete");
}catch{console.error("auth migration failed");process.exitCode=1;}finally{await pool.end();}
