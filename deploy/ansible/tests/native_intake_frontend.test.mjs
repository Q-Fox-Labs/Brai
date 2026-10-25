'use strict';
// ABOUTME: Проверяет форму intake на синтетических DOM и Telegram SDK.
// ABOUTME: Не запускает сервер и не подменяет production авторизацию.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../roles/brai_install/files/hermes_intake_assets/app.js',import.meta.url), 'utf8');
const SYNTHETIC = 'gsk_' + 'Z'.repeat(48);
function harness({initData='synthetic-init-data', authorized=true, networkFailure=false}={}) {
  const created = [], requests = [], timers = [];
  function element(tag) {
    const e = {tag, value: '', children: [], events: {}, removed: false,
      append(...children) { this.children.push(...children); },
      addEventListener(name, fn) { this.events[name] = fn; },
      reportValidity() { return true; }, remove() { this.removed = true; }};
    created.push(e);
    return e;
  }
  const status = element('status'), area = element('area');
  const context = {
    document: {getElementById(id) { return id === 'status' ? status : area; }, createElement: element},
    location: {origin: 'https://pavel.brai.one', protocol: 'https:'},
    window: {Telegram: {WebApp: {initData, ready() {}}}},
    setTimeout(fn, ms) { timers.push({fn, ms}); },
    async fetch(path, options) {
      const body = JSON.parse(options.body);
      requests.push({path, options, body});
      if (networkFailure) throw new Error('synthetic failure');
      if (path.endsWith('/authorize')) {
        // Form must not exist until authentication reply is received.
        assert.equal(created.filter(e => e.tag === 'input').length, 0);
        return {ok: authorized, async json() {return authorized
          ? {status: 'authorized', message: 'Авторизовано', operation_token: 'synthetic-operation-token'}
          : {status: 'unauthorized', message: 'Доступ запрещён'}; }};
      }
      return {ok: true, async json() { return {status:'saved', message:'Ключ сохранён'}; }};
    }
  };
  return {created, requests, timers, status, area,
    async run() { await vm.runInNewContext(source, context); }};
}
test('no Telegram initData means no form and no request', async () => {
  const h = harness({initData:''}); await h.run();
  assert.equal(h.requests.length, 0);
  assert.equal(h.created.filter(e => e.tag === 'input').length, 0);
});
test('denied authorization never creates password input', async () => {
  const h = harness({authorized:false}); await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.created.filter(e => e.tag === 'input').length, 0);
});
test('authorized form is password, submits same-origin JSON once and clears it', async () => {
  const h = harness(); await h.run();
  const input = h.created.find(e => e.tag === 'input');
  const form = h.created.find(e => e.tag === 'form');
  assert.equal(input.type, 'password');
  assert.equal(input.maxLength, 128);
  assert.equal(new RegExp('^(?:'+input.pattern+')$', 'v').test(SYNTHETIC), true);
  input.value = SYNTHETIC;
  await form.events.submit({preventDefault(){}});
  assert.equal(h.requests.length, 2);
  const req = h.requests[1];
  assert.equal(req.path, '/connect/groq/submit');
  assert.equal(req.body.api_key, SYNTHETIC);
  assert.equal(req.body.init_data, 'synthetic-init-data');
  assert.equal(req.options.method, 'POST');
  assert.equal(req.options.redirect, 'error');
  assert.equal(req.options.cache, 'no-store');
  assert.equal(req.path.includes(SYNTHETIC), false);
  assert.equal(input.value, '');
  assert.equal(form.removed, true);
  assert.equal(h.status.textContent.includes(SYNTHETIC), false);
  await form.events.submit({preventDefault(){}});
  assert.equal(h.requests.length, 2);
});
test('client expiration removes form and clears password', async () => {
  const h = harness(); await h.run();
  const input = h.created.find(e => e.tag === 'input');
  const form = h.created.find(e => e.tag === 'form');
  input.value = SYNTHETIC;
  assert.equal(h.timers[0].ms, 600000);
  h.timers[0].fn();
  assert.equal(input.value, '');
  assert.equal(form.removed, true);
  await form.events.submit({preventDefault(){}});
  assert.equal(h.requests.length, 1);
});
test('network error neither renders form nor reflects exception', async () => {
  const h = harness({networkFailure:true}); await h.run();
  assert.equal(h.created.filter(e => e.tag === 'input').length, 0);
  assert.equal(h.status.textContent.includes('synthetic failure'), false);
});
