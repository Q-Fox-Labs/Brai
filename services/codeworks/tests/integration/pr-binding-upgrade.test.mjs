// ABOUTME: Проверяет перенос PR из живых и удалённых областей настоящим SQL миграции.
// ABOUTME: Использует только disposable БД и транзакционные схемы; существующие таблицы не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {configured,readConfig} from './fixture.mjs';
import {createPullRequests} from '../../src/pull-requests.mjs';

test('PR migration skips removed history but preserves live identity conflicts',{skip:!configured},async t=>{
  const config=await readConfig(),pool=new Pool({connectionString:config.owner_url});
  const migration=await readFile(new URL('../../migrations/015.sql',import.meta.url),'utf8');
  try {
    for(const scenario of ['live-single','removed-multiple','live-successive','same-pr-new-head','live-multiple','foreign-owner'])await t.test(scenario,async()=>{
      const db=await pool.connect(),schema='pr_binding_upgrade_'+randomUUID().replaceAll('-','');
      const live=randomUUID(),removed=randomUUID(),other=randomUUID();
      try {
        await db.query('BEGIN');
        await db.query('CREATE SCHEMA '+schema);
        await db.query(`CREATE TABLE ${schema}.projects(id text PRIMARY KEY,config jsonb NOT NULL);
          CREATE TABLE ${schema}.workspaces(id uuid PRIMARY KEY,project_id text NOT NULL,removed_at timestamptz,UNIQUE(id,project_id));
          CREATE TABLE ${schema}.operations(workspace_id uuid,kind text,result jsonb);
          CREATE TABLE ${schema}.releases(workspace_id uuid,details jsonb);`);
        await db.query(`INSERT INTO ${schema}.projects VALUES('fixture',$1)`,[{github:{repository:'Fixture/Repository'}}]);
        await db.query(`INSERT INTO ${schema}.workspaces VALUES($1,'fixture',NULL),($2,'fixture',now())`,[live,removed]);
        const leg=(number,head='a'.repeat(40))=>({branch:'feature/task',target:'dev',head,pr_number:number});
        await db.query(`INSERT INTO ${schema}.operations VALUES($1,'sync',$2),($3,'sync',$4)`,[live,{primary:leg(1)},removed,{primary:leg(2)}]);
        await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(1)}]);
        if(scenario==='removed-multiple')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[removed,{primary:leg(3)}]);
        if(scenario==='live-multiple')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(4)}]);
        if(scenario==='live-successive')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(4,'b'.repeat(40))}]);
        if(scenario==='same-pr-new-head')await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[live,{primary:leg(1,'b'.repeat(40))}]);
        if(scenario==='foreign-owner'){
          await db.query(`INSERT INTO ${schema}.workspaces VALUES($1,'fixture',NULL)`,[other]);
          await db.query(`INSERT INTO ${schema}.releases VALUES($1,$2)`,[other,{primary:{...leg(1,'b'.repeat(40)),branch:'feature/other'}}]);
        }
        // Меняется только имя изолированной схемы, исполняется сам SQL поставки.
        const sql=migration.replaceAll('codeworks.',schema+'.');
        if(['live-multiple','foreign-owner'].includes(scenario))await assert.rejects(db.query(sql),{code:'23505'});
        else {
          await db.query(sql);
          const rows=(await db.query(`SELECT workspace_id,repository,pr_number FROM ${schema}.pull_requests ORDER BY pr_number`)).rows;
          const expected=[{workspace_id:live,repository:'fixture/repository',pr_number:'1'}];
          if(scenario==='live-successive')expected.push({...expected[0],pr_number:'4'});
          assert.deepEqual(rows,expected);
          const heads=(await db.query(`SELECT head_sha,pr_number FROM ${schema}.pull_request_heads ORDER BY head_sha`)).rows;
          const expectedHeads=[{head_sha:'a'.repeat(40),pr_number:'1'}];
          if(scenario==='live-successive'||scenario==='same-pr-new-head')expectedHeads.push({head_sha:'b'.repeat(40),pr_number:scenario==='live-successive'?'4':'1'});
          assert.deepEqual(heads,expectedHeads);
          const port=createPullRequests({query:(sql,args)=>db.query(sql.replaceAll('codeworks.',schema+'.'),args)});
          const project={id:'fixture',github:{repository:'Fixture/Repository'}},workspace={id:live},leg={branch:'feature/task',target:'dev',head:'a'.repeat(40)};
          assert.equal(await port.get(project,workspace,leg),1);
          const next={...leg,head:'c'.repeat(40)};
          await port.bind(project,workspace,next,{number:5});assert.equal(await port.get(project,workspace,next),5);
          assert.equal(await port.get(project,workspace,leg),1);
          await port.bind(project,workspace,{...leg,head:'d'.repeat(40)},{number:1});
          assert.equal(await port.get(project,workspace,{...leg,head:'d'.repeat(40)}),1);
          await assert.rejects(port.bind(project,workspace,leg,{number:5}),{code:'PR_IDENTITY_CONFLICT'});
          await assert.rejects(port.bind(project,{id:removed},{...next,branch:'feature/foreign',head:'e'.repeat(40)},{number:1}),{code:'PR_IDENTITY_CONFLICT'});
          assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${schema}.operations WHERE workspace_id=$1`,[removed])).rows[0].count,1);
          if(scenario==='removed-multiple')assert.equal((await db.query(`SELECT details->'primary'->>'pr_number' AS number FROM ${schema}.releases WHERE workspace_id=$1`,[removed])).rows[0].number,'3');
        }
      }finally{await db.query('ROLLBACK');db.release();}
    });
  }finally{await pool.end();}
});
