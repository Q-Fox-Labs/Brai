// ABOUTME: Проверяет повторы ремонта, guards, CAS и исходный audit на отдельной тестовой PostgreSQL.
// ABOUTME: Порт Ansible подменён; тест не устанавливает runtime и не делает внешних запросов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../../src/ci-verifier.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {configured,readConfig,setup} from './fixture.mjs';
import {repairPostprocess} from '../../src/postprocess-repair.mjs';

test('postprocess repair preserves failed audit, exact proof, active lane and same-key recovery',{skip:!configured},async t=>{
  const config=await readConfig(),f=await setup({strictVerifier:!!config.verifier_url});
  const verifierPool=config.verifier_url?new Pool({connectionString:config.verifier_url,max:2}):f.app;
  const sha='a'.repeat(40),digest='sha256:'+'c'.repeat(64);
  const normalize=value=>JSON.parse(JSON.stringify(value));
  try{
    const make=async({parent=false}={})=>{
      const project=await f.project(),deploymentId=randomUUID(),parentId=parent?randomUUID():null;
      let workspaceId;
      if(parent)workspaceId=(await f.prepare({project_id:project.id,workspace_key:'repair-fixture',kind:'feature',request_key:randomUUID()})).workspace_id;
      await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[project.id]);
      if(parent){
        await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','failed','DEPLOYMENT_FAILED',$4)",[parentId,project.id,workspaceId,{commit_sha:sha}]);
        await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'failed',$5)",[randomUUID(),workspaceId,parentId,sha,{primary:{merged:true,merge_sha:sha,deployment_operation_id:deploymentId}}]);
        await f.owner.query("UPDATE codeworks.commands SET state='done',delivered_at=now() WHERE operation_id=$1",[parentId]);
      }
      const composition={target:'dev',source:sha,components:[]};
      const receipt={operation_id:deploymentId,project_id:project.id,target:'dev',commit_sha:sha,composition_digest:digest,composition,verified:true,evidence_url:'https://fixture.invalid/'+deploymentId};
      const runtime=createHash('sha256').update(JSON.stringify(canonical({status:'succeeded',receipt}))).digest('hex');
      const failed={operation_id:deploymentId,status:'failed',code:'RUNBOOK_POSTPROCESSING_FAILED',runtime_status:'succeeded',receipt};
      await f.owner.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request,result) VALUES($1,$2,'codeworks_owner','rollout','failed','ANSIBLE_ROLLOUT_FAILED',$3,$4)",[deploymentId,project.id,{target:'dev',commit_sha:sha},failed]);
      await f.owner.query("INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition,receipt,release_operation_id) VALUES($1,$2,'dev',$3,'1','1',$4,$5,$6,$7)",[deploymentId,project.id,sha,digest,composition,failed,parentId]);
      await f.owner.query("INSERT INTO codeworks.release_queue(project_id,target,operation_id,state) VALUES($1,'dev',$2,'held')",[project.id,parentId??deploymentId]);
      const request={deployment_id:deploymentId,expected_runtime_sha256:runtime,expected_composition_digest:digest,request_key:randomUUID()};
      const preflight=async()=>({operation_id:deploymentId,eligible:true,runtime_sha256:runtime,composition_digest:digest,target:'dev'});
      const success=(id,repair,key)=>({operation_id:id,repair_id:repair,request_key:key,status:'succeeded',runtime_status:'succeeded',receipt,postprocess_repair:{repair_id:repair,request_key:key,runtime_sha256:runtime,composition_digest:digest,phase:'export',status:'succeeded'}});
      await f.owner.query("UPDATE codeworks.operations SET updated_at=TIMESTAMPTZ '2026-11-11 12:00:00.123456+00' WHERE id=$1 OR id=$2",[deploymentId,parentId]);
      const snapshot=async()=>normalize({
        operation:(await f.owner.query('SELECT *,updated_at::text AS updated_at_token FROM codeworks.operations WHERE id=$1',[deploymentId])).rows[0],
        deployment:(await f.owner.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1',[deploymentId])).rows[0],
      });
      return {project,deploymentId,parentId,workspaceId,request,preflight,success,snapshot,receipt};
    };
    await t.test('unknown then inspect resumes one repair ID and immutable original snapshots',async()=>{
      const x=await make({parent:true}),before=await x.snapshot();let invokes=0,inspects=0;
      const adapter={preflight:x.preflight,invoke:async()=>{invokes++;throw Error('lost response');},inspect:async(...args)=>{inspects++;return x.success(...args);}};
      const call=()=>repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      const pending=await call();assert.equal(pending.status,'awaiting_reconciliation');
      const completed=await call();assert.equal(completed.status,'succeeded');assert.equal(completed.operation_id,pending.operation_id);
      assert.equal(invokes,1);assert.equal(inspects,1);
      assert.deepEqual(await call(),completed);assert.equal(inspects,1);
      const audit=(await f.app.query('SELECT request FROM codeworks.operations WHERE id=$1',[completed.operation_id])).rows[0].request.original;
      assert.deepEqual(audit.operation,before.operation);assert.deepEqual(audit.deployment,before.deployment);
      assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[x.parentId])).rows[0].status,'awaiting_reconciliation');
      assert.equal((await f.app.query('SELECT state FROM codeworks.release_queue WHERE operation_id=$1',[x.parentId])).rows[0].state,'held');
      assert.equal((await f.app.query('SELECT state FROM codeworks.commands WHERE operation_id=$1',[x.parentId])).rows[0].state,'pending');
      await assert.rejects(repairPostprocess(f.app,x.project.id,{...x.request,expected_runtime_sha256:'d'.repeat(64)},{adapter,verifierPool}),/POSTPROCESS_REPAIR_REQUEST_CONFLICT/);
    });
    await t.test('foreign lane and completed tombstone refuse before invoking repair',async()=>{
      const x=await make();let calls=0;const adapter={preflight:x.preflight,invoke:async()=>{calls++;}};
      await f.owner.query("UPDATE codeworks.release_queue SET state='released' WHERE operation_id=$1",[x.deploymentId]);
      await assert.rejects(repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool}),/POSTPROCESS_REPAIR_LANE_REQUIRED/);
      assert.equal(calls,0);
      await f.owner.query("UPDATE codeworks.release_queue SET state='held' WHERE operation_id=$1",[x.deploymentId]);
      await f.owner.query("UPDATE codeworks.workflow_registry SET state='completed',completed_at=now() WHERE operation_id=$1",[x.deploymentId]);
      await assert.rejects(repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool}),/POSTPROCESS_REPAIR_TASK_CLOSED/);
      assert.equal(calls,0);
    });
    await t.test('mismatched linked proof never creates installed or rewrites failed rollout',async()=>{
      const x=await make(),before=await x.snapshot();
      const adapter={preflight:x.preflight,invoke:async(...args)=>({...x.success(...args),postprocess_repair:{repair_id:args[1],request_key:args[2],runtime_sha256:'f'.repeat(64),composition_digest:digest,phase:'export',status:'succeeded'}})};
      const result=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(result.status,'failed');assert.equal(result.step,'POSTPROCESS_REPAIR_PROOF_MISMATCH');
      assert.deepEqual(await x.snapshot(),before);
      assert.equal((await f.app.query('SELECT 1 FROM codeworks.installed WHERE project_id=$1',[x.project.id])).rowCount,0);
    });
    await t.test('verify phase cannot report success and echoing a foreign runtime hash cannot pass',async()=>{
      for(const altered of ['verify','runtime']){
        const x=await make();
        if(altered==='runtime')x.request.expected_runtime_sha256='f'.repeat(64);
        const adapter={preflight:async()=>({...await x.preflight(),runtime_sha256:x.request.expected_runtime_sha256}),invoke:async(...args)=>{
          const result=x.success(...args);
          if(altered==='verify')result.postprocess_repair.phase='verify';
          else result.postprocess_repair.runtime_sha256=x.request.expected_runtime_sha256;
          return result;
        }};
        const result=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
        assert.equal(result.status,'failed');assert.equal(result.step,'POSTPROCESS_REPAIR_PROOF_MISMATCH');
        assert.equal((await f.app.query('SELECT 1 FROM codeworks.installed WHERE project_id=$1',[x.project.id])).rowCount,0);
      }
    });
    await t.test('unknown inspection remains pending and later exact export can complete',async()=>{
      const x=await make();let inspections=0;
      const adapter={preflight:x.preflight,invoke:async()=>{throw Error('unknown launch');},inspect:async(...args)=>++inspections===1?{operation_id:args[0],repair_id:args[1],request_key:args[2],status:'unknown'}:x.success(...args)};
      const first=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      const unknown=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(unknown.status,'awaiting_reconciliation');assert.equal(unknown.operation_id,first.operation_id);
      const done=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(done.status,'succeeded');
    });
    await t.test('verified unstarted repeats invoke with the same repair ID',async()=>{
      const x=await make();let invokedId,phase=0;
      const adapter={preflight:x.preflight,invoke:async(...args)=>{if(phase++===0){invokedId=args[1];throw Error('lost before start');}assert.equal(args[1],invokedId);return x.success(...args);},inspect:async(id,repair,key)=>({operation_id:id,repair_id:repair,request_key:key,status:'unstarted'})};
      const first=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(first.status,'awaiting_reconciliation');
      const last=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(last.status,'succeeded');assert.equal(last.operation_id,first.operation_id);
      assert.equal((await f.app.query('SELECT state FROM codeworks.release_queue WHERE operation_id=$1',[x.deploymentId])).rows[0].state,'released');
    });
    await t.test('crash after ordinary runtime verification resumes without a second invoke',async()=>{
      const x=await make();let invokes=0,inspects=0,crash=true;
      const adapter={preflight:x.preflight,invoke:async(...args)=>{invokes++;return x.success(...args);},inspect:async(...args)=>{inspects++;return x.success(...args);}};
      await assert.rejects(repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool,checkpoint:async stage=>{if(stage==='postprocess-before-resume'&&crash){crash=false;throw Error('fixture interrupted after trusted verification');}}}),/fixture interrupted/);
      assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[x.deploymentId])).rows[0].status,'failed');
      assert.equal((await f.app.query('SELECT 1 FROM codeworks.installed WHERE project_id=$1',[x.project.id])).rowCount,1);
      const done=await repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool});
      assert.equal(done.status,'succeeded');assert.equal(invokes,1);assert.equal(inspects,1);
    });
    await t.test('lost database session aborts completion and preserves the failed source',async()=>{
      const x=await make(),before=await x.snapshot();let session;
      const guardedPool={connect:async()=>{session=await f.app.connect();return session;}};
      const adapter={preflight:x.preflight,invoke:async(...args)=>x.success(...args)};
      await assert.rejects(repairPostprocess(guardedPool,x.project.id,x.request,{adapter,verifierPool,checkpoint:async stage=>{if(stage==='postprocess-after-external')session.emit('error',Error('fixture session disconnected'));}}),{code:'GIT_FAILED'});
      assert.deepEqual(await x.snapshot(),before);
      assert.equal((await f.app.query('SELECT 1 FROM codeworks.installed WHERE project_id=$1',[x.project.id])).rowCount,0);
    });
    await t.test('source change after external success is refused by CAS without reviving parent',async()=>{
      const x=await make({parent:true});
      const adapter={preflight:x.preflight,invoke:async(...args)=>{await f.owner.query("UPDATE codeworks.operations SET step='CHANGED_EXTERNALLY',updated_at=clock_timestamp() WHERE id=$1",[x.deploymentId]);return x.success(...args);}};
      await assert.rejects(repairPostprocess(f.app,x.project.id,x.request,{adapter,verifierPool}),/POSTPROCESS_REPAIR_SOURCE_CHANGED/);
      assert.equal((await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[x.parentId])).rows[0].status,'failed');
    });
  }finally{if(verifierPool!==f.app)await verifierPool.end();await f.close();}
});
