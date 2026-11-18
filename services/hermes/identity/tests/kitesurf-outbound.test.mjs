// ABOUTME: Проверяет передачу сетевых запросов Kitesurf через заданный прокси.
// ABOUTME: Не подтверждает совместимость сайтов или изоляцию процесса.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kitesurfOutbound } from '../kitesurf_outbound.mjs';

test('передаёт запрос в прокси без автоматического перехода по redirect', async () => {
  const dispatcher = {dispatch() {}};
  const input = new Request('https://public.example/', {method: 'POST', body: 'synthetic'});
  let called = 0;
  const send = kitesurfOutbound(async (url, options) => {
    called++;
    assert.equal(url, input.url);
    assert.equal(options.dispatcher, dispatcher);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.body, input.body);
    assert.equal(options.duplex, 'half');
    return new Response(null, {status: 302, headers: {location: 'https://other.example/'}});
  }, dispatcher);
  assert.equal((await send(input)).status, 302);
  assert.equal(called, 1);
});

test('ошибка прокси не приводит к прямому выходу или повтору', async () => {
  let called = 0;
  const send = kitesurfOutbound(async () => { called++; throw new Error('proxy unavailable'); },
                                {dispatch() {}});
  await assert.rejects(send(new Request('https://public.example/')), /proxy unavailable/);
  assert.equal(called, 1);
});

test('не принимает произвольную схему и WebSocket upgrade', async () => {
  let called = false;
  const send = kitesurfOutbound(async () => { called = true; }, {dispatch() {}});
  await assert.rejects(send({url:'file:///private', headers:new Headers()}), /Unsupported/);
  await assert.rejects(send({url:'https://public.example/', headers:new Headers({upgrade:'websocket'})}), /Unsupported/);
  assert.equal(called, false);
  assert.throws(() => kitesurfOutbound(() => {}, null), /trusted proxy/);
});
