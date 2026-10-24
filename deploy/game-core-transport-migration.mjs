// ABOUTME: Копирует сохранённые события прежнего транспорта в game-core с теми же UUID.
// ABOUTME: Требует остановленных производителей и потребителей; старый stream не удаляет.
import assert from 'node:assert/strict';
import { connect } from 'nats';
import { pathToFileURL } from 'node:url';
import { streamConfig, consumerConfigs } from './game-core-jetstream-config.mjs';

const oldName = 'BRAI_ELEMENTS_EVENTS_V1';
const oldPrefix = 'brai.elements.v1.events.';
const prefix = 'brai.game-core.v1.events.';

async function readMessages(manager, name, state) {
  const messages = new Map();
  if (state.messages === 0) return messages;
  for (let seq = state.first_seq; seq <= state.last_seq; seq++) {
    let message;
    try { message = await manager.streams.getMessage(name, { seq }); }
    catch (error) { if (error.api_error?.err_code === 10037) continue; throw error; }
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data));
    assert.match(event.event_id, /^[0-9a-f-]{36}$/i);
    const saved = messages.get(event.event_id);
    if (saved) {
      assert.equal(saved.subject, message.subject, 'CONFLICTING_EVENT_SUBJECT');
      assert.deepEqual(saved.data, message.data, 'CONFLICTING_EVENT_DATA');
    }
    messages.set(event.event_id, { subject: message.subject, data: message.data });
  }
  return messages;
}

/** Переносит ограниченный stream с проверкой повторов; любой конфликт сохраняет оба stream. */
export async function migrateStream(nc) {
  const manager = await nc.jetstreamManager();
  let old;
  try { old = await manager.streams.info(oldName); }
  catch (error) { if (error.code !== '404') throw error; }
  try { await manager.streams.info(streamConfig.name); }
  catch (error) { if (error.code !== '404') throw error; await manager.streams.add({ ...streamConfig, subjects: [...streamConfig.subjects] }); }
  const current = await manager.streams.info(streamConfig.name);
  for (const [key,value] of Object.entries(streamConfig)) assert.deepEqual(current.config[key],value);
  if (old) {
    const source = await readMessages(manager,oldName,old.state);
    const target = await readMessages(manager,streamConfig.name,current.state);
    for (const [id,message] of source) {
      assert.ok(message.subject.startsWith(oldPrefix), 'UNEXPECTED_OLD_SUBJECT');
      const subject = prefix + message.subject.slice(oldPrefix.length);
      const saved = target.get(id);
      if (saved) {
        assert.equal(saved.subject,subject);
        assert.deepEqual(saved.data,message.data);
      } else await nc.jetstream().publish(subject,message.data,{msgID:id});
    }
    const after = await manager.streams.info(oldName);
    assert.deepEqual(after.state,old.state,'OLD_STREAM_CHANGED');
    const copied = await readMessages(manager,streamConfig.name,(await manager.streams.info(streamConfig.name)).state);
    for (const [id,message] of source) assert.deepEqual(copied.get(id)?.data,message.data);
  }
  for (const expected of consumerConfigs) {
    try { await manager.consumers.info(streamConfig.name,expected.durable_name); }
    catch (error) { if (error.code !== '404') throw error; await manager.consumers.add(streamConfig.name,{...expected}); }
    const actual=(await manager.consumers.info(streamConfig.name,expected.durable_name)).config;
    for(const [key,value] of Object.entries(expected))assert.deepEqual(actual[key],value);
  }
  return { migrated:true, legacyStreamRetained:!!old };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let nc;
  try {
    assert.equal(process.env.BRAI_ENVIRONMENT,'dev');
    nc=await connect({servers:process.env.NATS_URL,user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD,inboxPrefix:process.env.NATS_INBOX_PREFIX,reconnect:false,timeout:5000});
    console.log(JSON.stringify(await migrateStream(nc)));
  } catch { console.error('GAME_CORE_STREAM_MIGRATION_FAILED');process.exitCode=1; }
  finally { await nc?.close(); }
}
