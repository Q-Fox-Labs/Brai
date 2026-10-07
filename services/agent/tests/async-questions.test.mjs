// ABOUTME: Проверяет асинхронные вопросы на границе native сообщения и answer.
// ABOUTME: Подставляет только Codex transport; карточка использует обычный question контракт.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from '../dist/application.js';
import { asyncQuestionRequest, asyncQuestionReply, asyncReplyIds } from '../dist/async-questions.js';
const item = { id: 'call_test', type: 'agentMessage', delivery: 'async', phase: 'final_answer', text: 'Choose\n- One\n- Two', questions: [{ title: 'Choose?', options: ['One (Recommended)', 'Two'] }, { title: 'Your text?' }] };
const nativeQuestionId = index => JSON.stringify(['request_user_input_async', 'call_test', index]);
function fixture({ history = [], active = false, failure, pages, gate } = {}) {
  let observe; const calls = [];
  const thread = { id: 't', name: 'Test', cwd: '/tmp/demo', model: 'gpt-6-luna', updatedAt: 1, status: { type: 'idle' } };
  const app = createApplication({
    status: () => ({ generation: 'g', connection: 'connected', authorization: 'ready' }),
    subscribe: callback => { observe = callback; return () => {}; },
    call: async (method, params) => {
      if (method === 'thread/read') return { thread };
      if (method === 'thread/resume') return { thread, model: thread.model };
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: active ? 'inProgress' : 'completed' }] };
      if (method === 'thread/items/list') return pages ? pages[params.cursor ? 1 : 0] : { data: history.slice().reverse().map(item => ({ item, turnId: 'turn' })) };
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'turn/start' || method === 'turn/steer') {
        calls.push({ method, params });
        if (gate) await gate;
        if (failure) throw Object.assign(new Error('failure'), { outcome: failure });
        return { turn: { id: 'next', status: 'inProgress' }, turnId: 'turn' };
      }
      throw new Error(method);
    },
  }, { projects: [{ projectId: 'demo', name: 'Demo', cwd: thread.cwd }] }, () => {});
  const open = () => app.request({ action: 'open', projectId: 'demo', threadId: 't' });
  const answer = (values, operationId = 'answer') => app.request({ action: 'answer', projectId: 'demo', threadId: 't', generation: 'g', operationId, requestId: 'async:call_test', answer: { answers: Object.fromEntries(values.map((answers, index) => [nativeQuestionId(index), { answers }])) } });
  const emit = (method, params) => observe({ type: 'notification', method, params: { threadId: 't', turnId: 'turn', ...params } });
  return { app, open, answer, calls, emit };
}
test('uses explicit questions, not Markdown; preserves original Desktop IDs and recommendation', () => {
  const request = asyncQuestionRequest(item, 'turn');
  assert.equal(request.params.questions[0].id, nativeQuestionId(0));
  assert.equal(request.params.questions[0].options[0].label, 'One (Recommended)');
  assert.equal(request.params.questions[1].isOther, true);
  assert.equal(asyncQuestionRequest({ ...item, questions: null }, 'turn'), null);
  assert.equal(asyncQuestionRequest({ ...item, delivery: null }, 'turn'), null);
});
test('hydrates persisted async questions and sends one native reply after the turn completes', async () => {
  const f = fixture({ history: [item] });
  try {
    assert.equal((await f.open()).requests[0].kind, 'question');
    f.emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    assert.equal((await f.open()).requests.length, 1);
    await Promise.all([f.answer([['One (Recommended)'], []]), f.answer([['One (Recommended)'], []])]);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'turn/start');
    const text = f.calls[0].params.input[0].text;
    assert.deepEqual(JSON.parse(text.split('\n')[1]), [
      { questionItemId: nativeQuestionId(0), question: 'Choose?', answer: 'One (Recommended)' },
      { questionItemId: nativeQuestionId(1), question: 'Your text?', answer: '' },
    ]);
    assert.ok((await f.open()).requests[0].answered);
    await assert.rejects(f.answer([[], []], 'second'), error => error.code === 'STALE_REQUEST');
  } finally { f.app.close(); }
});
test('a live async question steers the current turn; no settings or collaboration overrides', async () => {
  const f = fixture({ active: true });
  try {
    await f.open(); f.emit('item/completed', { item });
    await f.answer([['Custom'], ['Details']]);
    assert.equal(f.calls[0].method, 'turn/steer');
    assert.equal(f.calls[0].params.expectedTurnId, 'turn');
    assert.deepEqual(Object.keys(f.calls[0].params).sort(), ['clientUserMessageId', 'expectedTurnId', 'input', 'threadId']);
  } finally { f.app.close(); }
});
test('a reply from another client resolves only matching questions, including after hydration', async () => {
  const reply = index => ({ type: 'userMessage', id: 'reply' + index, content: [{ type: 'text', text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: nativeQuestionId(index), question: item.questions[index].title, answer: 'Done' }]) + '\n</send_user_message_question_reply>' }] });
  const f = fixture({ history: [item, reply(0), reply(1)] });
  try { assert.ok((await f.open()).requests[0].answered); } finally { f.app.close(); }
  const g = fixture({ history: [item] });
  try {
    await g.open(); g.emit('item/completed', { item: reply(0) });
    assert.deepEqual((await g.open()).requests[0].params.questions.map(q => q.id), [nativeQuestionId(1)]);
    g.emit('item/completed', { item: reply(1) });
    assert.ok((await g.open()).requests[0].answered);
    assert.notEqual((await g.open()).state, 'waiting');
  } finally { g.app.close(); }
});
test('not-sent restores editing; unknown retains the claim and rejects a second operation', async () => {
  for (const failure of ['not-sent', 'unknown']) {
    const f = fixture({ history: [item], failure });
    try {
      await f.open(); await assert.rejects(f.answer([[], []]), error => error.outcome === failure);
      assert.equal((await f.open()).requests[0].answered, failure === 'unknown');
      if (failure === 'unknown') await assert.rejects(f.answer([[], []], 'second'), error => error.code === 'STALE_REQUEST');
    } finally { f.app.close(); }
  }
});
test('rejects missing IDs, malformed answer and whitespace; ordinary text cannot resolve a card', () => {
  const request = asyncQuestionRequest(item, 'turn');
  for (const answer of [{}, { answers: {} }, { answers: { [nativeQuestionId(0)]: { answers: [' '] }, [nativeQuestionId(1)]: { answers: [] } } }]) assert.equal(asyncQuestionReply(request, answer), null);
  assert.deepEqual(asyncReplyIds({ type: 'userMessage', content: [{ type: 'text', text: 'Example: <send_user_message_question_reply>[]</send_user_message_question_reply>' }] }), []);
});

test('rehydration finds async question behind actions without treating them as ten messages', async () => {
  const f = fixture({ pages: [
    { data: Array.from({ length: 10 }, (_, index) => ({ turnId: 'turn', item: { id: 'action'+index, type: 'reasoning', summary: [] } })), nextCursor: 'older' },
    { data: [{ turnId: 'turn', item }], nextCursor: null },
  ] });
  try { assert.equal((await f.open()).requests[0].requestId, 'async:call_test'); } finally { f.app.close(); }
});

test('a live reply before hydration of its question prevents resurrection', async () => {
  const f = fixture();
  try {
    await f.open();
    const request = asyncQuestionRequest(item, 'turn');
    const answer = { answers: Object.fromEntries(request.params.questions.map(q => [q.id, { answers: [] }])) };
    f.emit('item/completed', { item: { id: 'earlier-reply', type: 'userMessage', content: [{ type: 'text', text: asyncQuestionReply(request, answer) }] } });
    f.emit('item/completed', { item });
    assert.equal((await f.open()).requests[0].answered, true);
  } finally { f.app.close(); }
});

test('an in-flight claim prevents a second send without hiding the card on not-sent', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ history: [item], failure: 'not-sent', gate });
  try {
    await f.open();
    const first = f.answer([[], []]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal((await f.open()).requests[0].answered, false);
    await assert.rejects(f.answer([[], []], 'second-operation'), error => error.code === 'STALE_REQUEST');
    release(); await assert.rejects(first, error => error.outcome === 'not-sent');
    assert.equal((await f.open()).requests[0].answered, false);
  } finally { release(); f.app.close(); }
});
