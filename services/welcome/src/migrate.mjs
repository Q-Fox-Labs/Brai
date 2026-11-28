// ABOUTME: Устанавливает схему Welcome в отдельной БД под ролью владельца.
// ABOUTME: Рабочий процесс не выполняет DDL.
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const url=process.env.WELCOME_MIGRATION_DATABASE_URL;
const role=process.env.WELCOME_DATABASE_ROLE;
if(!url || !/^[a-z_][a-z_0-9]*$/.test(role??'')) throw Error('WELCOME_MIGRATION_CONFIG');
const pool=new pg.Pool({connectionString:url});
try {
 await pool.query(await readFile(new URL('../migrations/001.sql',import.meta.url),'utf8'));
 await pool.query(`GRANT USAGE ON SCHEMA welcome TO "${role}";
  GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA welcome TO "${role}";`);
} finally { await pool.end(); }
