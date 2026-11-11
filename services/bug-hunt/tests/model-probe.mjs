// ABOUTME: Проверяет реальные Gemma symmetric и Jev на ограниченных синтетических данных.
// ABOUTME: Сохраняет intent до dispatch; повтор запуска читает журнал и никогда не повторяет invoke.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { connect } from 'nats';
import Ajv from 'ajv';
import { validateRequest, validateResponse } from '../../local-ai/contracts/index.mjs';

assert.equal(process.env.BUG_HUNT_PREFLIGHT_TARGET, 'dev');
const run = process.env.BUG_HUNT_MODEL_PROBE_RUN;
assert.match(run ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const directory = new URL('../../../tmp/', import.meta.url);
mkdirSync(directory, { recursive: true });
const path = new URL('bug-hunt-model-probe-' + run + '.json', directory);
const model = { modelId:'embeddinggemma-2-q8',revision:'bfcd298762cc34d0357ece5ebdd31791a3a374d8',profileId:'embeddinggemma2_llama_cpp' };
const ownerId = 'bug-hunt-synthetic-' + run;
const fresh = !existsSync(path);
const journal = fresh ? {run, ownerId, model, embedding:null, classification:null} : JSON.parse(readFileSync(path,'utf8'));
if (fresh) writeFileSync(path, JSON.stringify(journal), {flag:'wx',mode:0o600});
const save = () => writeFileSync(path,JSON.stringify(journal),{mode:0o600});
const nc = await connect({servers:'nats://127.0.0.1:4223',user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD,inboxPrefix:'_INBOX.brai_alerts_admin',timeout:3000});
const ajv = new Ajv({strict:false});
ajv.addFormat('date-time', value => Number.isFinite(Date.parse(value)));
const schema = JSON.parse(readFileSync(new URL('../../providers/schemas/v1.schema.json',import.meta.url),'utf8'));
ajv.addSchema(schema,'providers');
const validOperation = ajv.compile({$ref:'providers#/definitions/operation'});
const validDecide = ajv.compile({$ref:'providers#/definitions/decideRequest'});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function request(subject,body,timeout=10000) {
  const response=await nc.request(subject,Buffer.from(JSON.stringify(body)),{timeout});
  if(response.headers?.get('Nats-Service-Error')) throw new Error('UPSTREAM_SAFE_ERROR');
  return JSON.parse(Buffer.from(response.data).toString('utf8'));
}
try {
  if(!journal.embedding) {
    const texts=[
      'После сохранения заметки текст исчезает. Ожидалось сохранение текста.',
      'Содержимое заметки пропадает, когда нажимаю Сохранить.',
      'Изменение цвета кнопки не применяется после обновления страницы.',
      'Note content disappears when Save is pressed.',
    ];
    const body={requestId:randomUUID(),operationId:randomUUID(),ownerId,deadlineAt:new Date(Date.now()+220000).toISOString(),model,purpose:'symmetric',texts};
    assert.ok(validateRequest('brai.local_ai.v1.invoke.embed',body));
    journal.embedding={state:'dispatch_intent',body};save();
    const reply=await request('brai.local_ai.v1.invoke.embed',body,230000);
    assert.ok(validateResponse('brai.local_ai.v1.invoke.embed',reply));
    assert.deepEqual(reply.model,model);
    assert.equal(reply.vectors.length,texts.length);
    for(const vector of reply.vectors) {
      assert.equal(vector.length,768);assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector)-1)<0.001);
    }
    const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
    journal.embedding={...journal.embedding,state:'succeeded',model:reply.model,dimensions:768,norms:reply.vectors.map(v=>Math.hypot(...v)),scores:{paraphrase:dot(reply.vectors[0],reply.vectors[1]),unrelated:dot(reply.vectors[0],reply.vectors[2]),english:dot(reply.vectors[0],reply.vectors[3])},vectorHashes:reply.vectors.map(v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'))};save();
  }
  if(!journal.classification) {
    const body={ownerId,operationId:randomUUID(),provider:'typesafe',model:'jev-1.13.0',deadlineAt:new Date(Date.now()+30000).toISOString(),
      state:{component:'synthetic-editor',expected:'Saved note remains available',observed:'Saving a note removes its text from the synthetic store'},
      questions:{suspected_defect:{type:'noul',instructions:'Does this synthetic observation describe a possible software defect? This is a preliminary suggestion, not verification.',criteria:{true:'Expected saved content is lost.',false:'No observable software problem is described.'}}}};
    assert.ok(validDecide(body));
    journal.classification={state:'dispatch_intent',body};save();
    const reply=await request('brai.providers.v1.invoke.decide',body);
    assert.ok(validOperation(reply));journal.classification.state=reply.phase;save();
  }
  const deadline=Date.now()+40000;
  while(journal.classification?.body && Date.now()<deadline) {
    const body=journal.classification.body;
    const reply=await request('brai.providers.v1.operations.get',{ownerId,operationId:body.operationId});
    assert.ok(validOperation(reply));
    assert.equal(reply.operationId,body.operationId);
    journal.classification={...journal.classification,state:reply.phase,result:reply.result,resultExpired:reply.resultExpired};save();
    if(!['accepted','dispatching'].includes(reply.phase))break;
    await delay(250);
  }
  assert.equal(journal.embedding.state,'succeeded','Unknown embedding is never re-invoked');
  assert.equal(journal.classification.state,'succeeded');
  assert.equal(journal.classification.resultExpired,false);
  assert.equal(journal.classification.result.actualModel,'jev-1.13.0');
  console.log(JSON.stringify({run,embedding:{state:journal.embedding.state,model,dimensions:768,scores:journal.embedding.scores},classification:{state:journal.classification.state,result:journal.classification.result}}));
} catch {
  console.error(JSON.stringify({code:'MODEL_PROBE_FAILED',run,embedding:journal.embedding?.state,classification:journal.classification?.state}));
  process.exitCode=1;
} finally {await nc.close();}
