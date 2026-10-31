// ABOUTME: Проверяет изоляцию владельцев, версии, аудит и параллельные резервы в отдельной тестовой БД.
// ABOUTME: Все значения синтетические; тест не использует данные рабочего DEV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../dist/migrate.js";
import { createDomain } from "../dist/domain.js";
import { refreshCbr, refreshKraken } from "../dist/rates.js";

const { Pool } = pg;
const ownerUrl = process.env.GOALS_TEST_OWNER_DATABASE_URL;
const appUrl = process.env.GOALS_TEST_DATABASE_URL;
const restartOnly = process.env.GOALS_TEST_RESTART === "true";
const persistentId = "00000000-0000-4000-8000-000000000031";
const rejected = code => error => error?.code === code;
const update = (domain, owner, entity, id, expected, data, requestId = randomUUID()) =>
  domain.change(owner,"test","synthetic test",requestId,entity,id,expected,data);

test("PostgreSQL: изоляция, версии, резервы и восстановление", {skip:!ownerUrl || !appUrl || restartOnly}, async () => {
 const ownerPool = new Pool({connectionString:ownerUrl}), pool = new Pool({connectionString:appUrl,max:8});
 try {
  await migrate(ownerPool,"goals_test_owner","goals_test_app");
  await migrate(ownerPool,"goals_test_owner","goals_test_app");
  const domain = createDomain(pool), alice = "synthetic-owner-a", bob = "synthetic-owner-b";
  const goal = persistentId, request = randomUUID();
  const goalData = {title:"Synthetic goal",meaning:"Synthetic reason",achievement:"Observable result",status:"discussing"};
  const first = await update(domain,alice,"goals",goal,null,goalData,request);
  assert.equal(first.version,"1");
  assert.deepEqual(await update(domain,alice,"goals",goal,null,goalData,request),first);
  await assert.rejects(update(domain,alice,"goals",goal,null,{...goalData,title:"Other"},request),rejected("CONFLICT"));
  assert.equal((await domain.list(bob,"goals")).length,0);
  await assert.rejects(update(domain,bob,"entries",randomUUID(),null,{goal_id:goal,kind:"thought",content:"Cross owner",occurred_on:"2026-10-31"}),rejected("NOT_FOUND"));
  const second = await update(domain,alice,"goals",goal,"1",{title:"Second"});
  assert.equal(second.version,"2");
  await assert.rejects(update(domain,alice,"goals",goal,"1",{title:"Stale"}),rejected("CONFLICT"));
  const restored = await domain.restore(alice,"test","restore synthetic",randomUUID(),"goals",goal,"2","1");
  assert.equal(restored.title,"Synthetic goal");
  assert.equal(restored.version,"3");
  assert.equal((await domain.history(alice,"goals",goal)).length,3);
  assert.equal((await domain.history(bob,"goals",goal)).length,0);
  await update(domain,alice,"focus",randomUUID(),null,{goal_id:goal,reason:"Explicit priority"});
  await assert.rejects(update(domain,alice,"goals",goal,"3",{deleted:true}),rejected("CONFLICT"));
  await assert.rejects(update(domain,bob,"focus",randomUUID(),null,{goal_id:goal,reason:"Cross owner"}),rejected("NOT_FOUND"));
  const entryId = randomUUID(), entryRequest = randomUUID();
  const entry = {goal_id:goal,kind:"result",content:"Synthetic result",occurred_on:"2026-10-31"};
  const sameRequest = await Promise.all([update(domain,alice,"entries",entryId,null,entry,entryRequest),update(domain,alice,"entries",entryId,null,entry,entryRequest)]);
  assert.deepEqual(sameRequest[0],sameRequest[1]);
  assert.equal((await domain.history(alice,"entries",entryId)).length,1);

  const resource = randomUUID(), needA = randomUUID(), needB = randomUUID();
  await update(domain,alice,"resources",resource,null,{title:"Synthetic funds",kind:"money",category:"own",state:"available",amount:"10.000000000001",currency:"RUB"});
  for (const id of [needA,needB]) await update(domain,alice,"needs",id,null,{goal_id:goal,title:"Synthetic need",kind:"money",amount:"7",currency:"RUB"});
  const reservations = await Promise.allSettled([needA,needB].map(need_id =>
    update(domain,alice,"allocations",randomUUID(),null,{need_id,resource_id:resource,amount:"7",active:true})));
  assert.equal(reservations.filter(item => item.status === "fulfilled").length,1);
  const failed = reservations.find(item => item.status === "rejected");
  assert.equal(failed.reason.code,"CONFLICT");
  await assert.rejects(update(domain,alice,"resources",resource,"1",{amount:"1"}),rejected("CONFLICT"));
  assert.equal((await domain.list(alice,"resources")).find(item => item.id === resource).amount,"10.000000000001");

  const debt = randomUUID();
  await update(domain,alice,"resources",debt,null,{title:"Synthetic obligation",kind:"liability",category:"obligation",state:"unknown",amount:"5.25",currency:"RUB"});
  await assert.rejects(update(domain,alice,"allocations",randomUUID(),null,{need_id:needA,resource_id:debt,amount:"1",active:true}),rejected("CONFLICT"));
  await update(domain,alice,"resources",randomUUID(),null,{title:"Unknown funds",kind:"money",category:"borrowed",state:"unknown",amount:null,currency:"RUB"});
  const overview = await domain.overview(alice);
  const available = overview.resource_balances.find(item => item.id === resource);
  assert.equal(available.reserved,"7");
  assert.equal(available.available,"3.000000000001");
  const own = overview.valuation.find(item => item.category === "own"), borrowed = overview.valuation.find(item => item.category === "borrowed"), obligations = overview.valuation.find(item => item.category === "obligation");
  assert.equal((await pool.query("SELECT $1::numeric = $2::numeric AS equal",[own.estimated_total,"10.000000000001"])).rows[0].equal,true);
  assert.equal(borrowed.estimated_total,null);
  assert.equal(borrowed.missing,1);
  assert.equal((await pool.query("SELECT $1::numeric = $2::numeric AS equal",[obligations.estimated_total,"5.25"])).rows[0].equal,true);
  await pool.query("INSERT INTO goals.exchange_rates(currency,rate,nominal,source,effective_date,fetched_at) VALUES('JPY',51.2345,100,'ЦБ РФ','2026-10-31',now()),('USD',81.2345,1,'ЦБ РФ','2026-10-31',now())");
  await update(domain,alice,"resources",randomUUID(),null,{title:"Synthetic yen",kind:"money",category:"own",state:"available",amount:"100",currency:"JPY"});
  const withYen = await domain.overview(alice);
  const ownWithYen = withYen.valuation.find(item => item.category === "own");
  assert.equal((await pool.query("SELECT $1::numeric = $2::numeric AS equal",[ownWithYen.estimated_total,"61.234500000001"])).rows[0].equal,true);
  const offline = async () => {throw new Error("offline");};
  await assert.rejects(refreshCbr(pool,offline));
  const stale = (await pool.query("SELECT rate::text,nominal::text,failed_at IS NOT NULL AS stale FROM goals.exchange_rates WHERE currency='JPY'")).rows[0];
  assert.deepEqual({rate:stale.rate,nominal:stale.nominal,stale:stale.stale},{rate:"51.2345",nominal:"100",stale:true});
  const kraken = async () => new Response(JSON.stringify({error:[],result:{USDTZUSD:{c:["0.9991"]}}}),{status:200});
  await refreshKraken(pool,kraken);
  const usdt = (await pool.query("SELECT rate=81.2345::numeric*0.9991::numeric AS correct,failed_at IS NOT NULL AS stale FROM goals.exchange_rates WHERE currency='USDT'")).rows[0];
  assert.deepEqual(usdt,{correct:true,stale:true});
  await assert.rejects(refreshKraken(pool,offline));
  assert.equal((await pool.query("SELECT rate=81.2345::numeric*0.9991::numeric AS preserved FROM goals.exchange_rates WHERE currency='USDT'")).rows[0].preserved,true);
  const count = await pool.query("SELECT count(*)::int AS count FROM goals.allocations WHERE owner_id=$1 AND active",[alice]);
  assert.equal(count.rows[0].count,1);
  const allocation = (await domain.list(alice,"allocations")).find(item => item.active);
  await assert.rejects(update(domain,alice,"resources",resource,"1",{deleted:true}),rejected("CONFLICT"));
  const removedAllocation = await update(domain,alice,"allocations",allocation.id,"1",{deleted:true,active:false});
  assert.equal(removedAllocation.deleted,true);
  const removedResource = await update(domain,alice,"resources",resource,"1",{deleted:true});
  assert.equal(removedResource.deleted,true);
  const restoredResource = await domain.restore(alice,"test","restore synthetic",randomUUID(),"resources",resource,"2","1");
  assert.equal(restoredResource.deleted,false);
  const restoredAllocation = await domain.restore(alice,"test","restore synthetic",randomUUID(),"allocations",allocation.id,"2","1");
  assert.equal(restoredAllocation.active,true);
  assert.equal((await domain.history(alice,"allocations",allocation.id)).length,3);
 } finally {await pool.end();await ownerPool.end();}
});

test("PostgreSQL: данные сохраняются после перезапуска fixture", {skip:!appUrl || !restartOnly}, async () => {
 const pool = new Pool({connectionString:appUrl});
 try {
  const rows = await createDomain(pool).list("synthetic-owner-a","goals");
  assert.equal(rows.find(row => row.id === persistentId)?.title,"Synthetic goal");
  assert.equal(rows.find(row => row.id === persistentId)?.version,"3");
 } finally {await pool.end();}
});
