// ABOUTME: Проверяет перенос PR из живых и удалённых областей настоящим SQL миграции.
// ABOUTME: Использует только disposable БД и транзакционные схемы; существующие таблицы не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {configured,readConfig} from './fixture.mjs';

test('PR migration skips removed history but preserves live identity conflicts',{skip:!configured},async t=>{
  const config=await readConfig(),pool=new Pool({connectionString:config.owner_url});
  const migration=await readFile(new URL('../../migrations/015.sql',import.meta.url),'utf8');
  try {
    for(const scenario of ['live-single','removed-multiple','live-multiple'])await t.test(scenario,async()=>{
      const db=await pool.connect(),schema='pr_binding_upgrade_'+randomUUID().replaceAll('-','');
      const live=randomUUID(),removed=randomUUID();
      try {
        await db.query('BEGIN');
        await db.query('CREATE SCHEMA '+schema);
        await db.query(`CREATE TABLE ${schema}.projects(id text PRIMARY KEY,config jsonb NOT NULL);
          CREATE TABLE ${schema}.workspaces(id uuid PRIMARY KEY,project_id text NOT NULL,removed_at timestamptz,UNIQUE(id,project_id));
          CREATE TABLE ${schema}.operations(workspace_id uuid,kind text,result jsonb);
          CREATE TABLE ${schema}.releases(workspace_id uuid,details jsonb);`);
        await db.query(`INSERT INTO ${schema}.projects VALUES('fixture',$1)`,[{github:{repository:'Fixture/Repository'}}]);
        await db.query(`INSERT INTO ${schema}.workspaces VALUES($1,'fixture',NULL),($2,'fixture',now())`,[live,removed]);
        const leg=number=>({branch:'feature/task',target:'dev',pr_number:number});
        await db.query(`INSERT INTO ${schema}.operations VALUES($1,'sync',$2),($3,'sync',$4)`,[live,{primary:leg(1)},removed,{primary:leg(2)}]);
        await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(1)}]);
        if(scenario==='removed-multiple')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[removed,{primary:leg(3)}]);
        if(scenario==='live-multiple')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(4)}]);
        // Меняется только имя изолированной схемы, исполняется сам SQL поставки.
        const sql=migration.replaceAll('codeworks.',schema+'.');
        if(scenario==='live-multiple')await assert.rejects(db.query(sql),{code:'23505'});
        else {
          await db.query(sql);
          const rows=(await db.query(`SELECT workspace_id,repository,pr_number FROM ${schema}.pull_requests`)).rows;
          assert.deepEqual(rows,[{workspace_id:live,repository:'fixture/repository',pr_number:'1'}]);
          assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${schema}.operations WHERE workspace_id=$1`,[removed])).rows[0].count,1);
          if(scenario==='removed-multiple')assert.equal((await db.query(`SELECT details->'primary'->>'pr_number' AS number FROM ${schema}.releases WHERE workspace_id=$1`,[removed])).rows[0].number,'3');
        }
      }finally{await db.query('ROLLBACK');db.release();}
    });
  }finally{await pool.end();}
});
