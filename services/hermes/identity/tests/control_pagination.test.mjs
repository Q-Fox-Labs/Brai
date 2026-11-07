// ABOUTME: Проверяет постраничное чтение больших административных архивов.
// ABOUTME: Использует только синтетические данные и ограничивает размер страницы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Control, createChatRead, createArtifactReader } from '../control.mjs';

const headers = { cookie: 'session=fixture', origin: 'https://example.test' };
function setup(ports) {
  return new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
    registry: async () => ({ version: 1, profiles: { '1001': { userId:'u1', profileId:'p1', status:'active' } } }),
    authCall: async op => op === 'session'
      ? { status:200, body:{user:{role:'admin',status:'active'},session:{}} } : { status:200 },
    ...ports });
}

test('more than 5000 messages and 1 MiB remain reachable in a stable snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'identity-pages-'));
  try {
    const db = new DatabaseSync(join(home, 'state.db'));
    db.exec("CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,last_activity_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL); INSERT INTO sessions VALUES('chat','telegram','Chat',1,1); BEGIN");
    const insert = db.prepare("INSERT INTO messages VALUES(?,'chat','user',?,1)");
    for (let i = 1; i <= 5501; i++) insert.run(i, 'x'.repeat(240) + i);
    db.exec('COMMIT');
    const reader = createChatRead();
    const profile = { userId:'u1', home, workerUid:process.getuid() };
    let cursor, count = 0, pages = 0, last;
    do {
      const page = await reader({ operation:'admin-chats-get', profile, id:'chat', cursor, limit:100 });
      assert.ok(page.messages.length <= 100);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1048576);
      count += page.messages.length; pages++; last = page.messages.at(-1)?.id;
      cursor = page.nextCursor ?? undefined;
      if (pages === 1) insert.run(99999, 'late message');
    } while (cursor);
    db.close();
    assert.equal(count, 5501);
    assert.equal(last, '5501');
    assert.equal(pages, 56);
  } finally { rmSync(home, { recursive:true, force:true }); }
});

test('artifact collection over 1000 items uses bounded owner pages and signed cursor', async () => {
  const requests = [], total = 1251;
  const artifactsCall = createArtifactReader({ internalBaseURL:'http://localhost:3004', wire: async (subject, args) => {
    requests.push(args);
    const length = Math.min(args.limit, total - args.offset);
    return { items: Array.from({length}, (_, i) => ({ artifactId: String(args.offset + i), ownerId:'u1', internalUrl:'private' })), total };
  } });
  const c = setup({ artifactsCall });
  let cursor, seen = 0, pages = 0;
  do {
    const result = await c.invoke('admin-artifacts-list', { headers, userId:'u1', limit:100, ...(cursor ? {cursor} : {}) });
    assert.equal(result.status, 200);
    assert.ok(result.body.items.length <= 100);
    assert.ok(result.body.items.every(item => !Object.hasOwn(item,'internalUrl')));
    seen += result.body.items.length; pages++; cursor = result.body.nextCursor;
    if (pages === 1) {
      const invalid = await c.invoke('admin-artifacts-list', { headers, userId:'other', limit:100, cursor });
      assert.notEqual(invalid.status, 200);
    }
  } while (cursor);
  assert.equal(seen, total);
  assert.equal(pages, 13);
  assert.ok(requests.every((request, i) => request.filter.ownerId === 'u1' && request.limit === 100 && request.offset === 100 * i));
});

test('recent chat reads keep ID pagination stable across new records without retaining snapshots', async () => {
  const home = mkdtempSync(join(tmpdir(), 'identity-recent-'));
  let db;
  try {
    db = new DatabaseSync(join(home, 'state.db'));
    db.exec("CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,last_activity_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL); INSERT INTO sessions VALUES('chat','telegram','Chat',1,1); INSERT INTO sessions VALUES('foreign','cli','Hidden',1,1)");
    const insert = db.prepare("INSERT INTO messages VALUES(?,'chat','user',?,1)");
    for (let id=1;id<=155;id++) insert.run(id,'text '+id);
    const reader=createChatRead(), profile={userId:'u1',home,workerUid:process.getuid()};
    const c=setup({registry:async()=>({version:1,profiles:{[process.getuid()]:{...profile,status:'active'}}}),chatRead:reader});
    const request={headers,userId:'u1',chatId:'chat',order:'desc',limit:50};
    const first=await c.invoke('admin-chats-get',request);
    assert.equal(first.status,200);
    assert.equal(first.body.messages[0].id,'106'); assert.equal(first.body.messages.at(-1).id,'155');
    insert.run(156,'new');
    const second=await c.invoke('admin-chats-get',{...request,cursor:first.body.nextCursor});
    assert.equal(second.status,200); assert.equal(second.body.messages[0].id,'56'); assert.equal(second.body.messages.at(-1).id,'105');
    const fresh=await c.invoke('admin-chats-get',request);
    assert.equal(fresh.body.messages.at(-1).id,'156');
    // AIDEV-NOTE: Прежний лимит 20 снимков не должен ограничивать непрерывное наблюдение.
    for(let i=0;i<25;i++) assert.equal((await c.invoke('admin-chats-get',request)).status,200);
    for(const extra of [{order:'asc',cursor:first.body.nextCursor},{chatId:'foreign'},{order:'sql'}]) assert.notEqual((await c.invoke('admin-chats-get',{...request,...extra})).status,200);
    let cursor=second.body.nextCursor, ids=[...second.body.messages,...first.body.messages].map(m=>m.id);
    while(cursor){const page=await c.invoke('admin-chats-get',{...request,cursor});assert.equal(page.status,200);ids.unshift(...page.body.messages.map(m=>m.id));cursor=page.body.nextCursor;}
    assert.deepEqual(ids,Array.from({length:155},(_,i)=>String(i+1)));
  } finally {db?.close();rmSync(home,{recursive:true,force:true});}
});
