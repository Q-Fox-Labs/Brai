// ABOUTME: Проверяет номиналы курсов и сохранение прежних значений при отказе источника.
// ABOUTME: Использует синтетические публичные ответы без личных данных.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCbr, parseKraken, refreshCbr, refreshKraken } from "../src/rates.ts";

const cbr = `<?xml version="1.0"?><ValCurs Date="31.10.2026" name="Foreign Currency Market">
  <Valute ID="R01235"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>81,2345</Value></Valute>
  <Valute ID="R01820"><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>51,2345</Value></Valute>
</ValCurs>`;

test("ЦБ: номинал и дата остаются частью исходного курса", () => {
  assert.deepEqual(parseCbr(cbr), [
    {currency:"USD",nominal:"1",rate:"81.2345",effectiveDate:"2026-10-31"},
    {currency:"JPY",nominal:"100",rate:"51.2345",effectiveDate:"2026-10-31"},
  ]);
  assert.throws(() => parseCbr(cbr.replace("31.10.2026","31.02.2026")));
  assert.throws(() => parseCbr(cbr.replace("JPY","USD")));
});
test("Kraken: USDT и USD различаются, читается last c[0]", () => {
  assert.equal(parseKraken({error:[],result:{USDTZUSD:{c:["0.99910000","1"]}}}),"0.99910000");
  assert.throws(() => parseKraken({error:[],result:{USD:{c:["1"]}}}));
  assert.throws(() => parseKraken({error:["EGeneral:Invalid arguments"],result:{USDTZUSD:{c:["1"]}}}));
});
test("Отказ провайдера помечает старые курсы, не перезаписывая их", async () => {
  const calls = [];
  const pool = {async query(sql) {calls.push(sql);return {rowCount:1};}};
  const unavailable = async () => {throw new Error("offline");};
  await assert.rejects(refreshCbr(pool, unavailable));
  await assert.rejects(refreshKraken(pool, unavailable));
  assert.equal(calls.length,2);
  assert.ok(calls.every(sql => sql.startsWith("UPDATE goals.exchange_rates SET failed_at=now()")));
});
test("Kraken не подменяет отсутствие курса USD нулём", async () => {
  const calls = [];
  const pool = {async query(sql) {calls.push(sql);return {rowCount:0};}};
  const fetcher = async () => new Response(JSON.stringify({error:[],result:{USDTZUSD:{c:["0.999"]}}}),{status:200});
  await assert.rejects(refreshKraken(pool,fetcher), /USD_RATE_UNAVAILABLE/);
  assert.match(calls[0],/FROM goals.exchange_rates WHERE currency='USD'/);
  assert.match(calls[1],/failed_at=now\(\)/);
});
