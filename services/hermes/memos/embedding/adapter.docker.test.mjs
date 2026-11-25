// ABOUTME: Проверяет восстановление адаптера памяти после перезапуска и пересоздания NATS.
// ABOUTME: Использует только отдельную Docker-сеть и синтетические данные в CI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const logs = (id) => {
  const output = spawnSync('docker', ['logs', id], { encoding: 'utf8', timeout: 120000 });
  if (output.error || output.status !== 0) throw Error('Cannot read fixture logs');
  return output.stdout + output.stderr;
};
const wait = async (operation) => {
  let error;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { return operation(); } catch (cause) { error = cause; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw error;
};

test('private adapter recovers after stopped and replaced broker', { skip: process.env.MEMOS_DOCKER_TEST !== '1' }, async () => {
  const suffix = randomUUID();
  const network = `memos-integration-${suffix}`;
  const directory = mkdtempSync(path.join(tmpdir(), 'memos-integration-'));
  const image = 'node:24.22.1-bookworm-slim';
  const brokerImage = 'nats:2.15.0';
  const containers = new Set();
  let networkId;
  let adapter;
  let testError;
  const start = (...args) => {
    const id = docker('create', '--label', `org.brai.memos-fixture=${suffix}`, ...args);
    containers.add(id);
    docker('start', id);
    return id;
  };
  const status = (container, field) => docker('inspect', '--format', `{{${field}}}`, container);
  const brokerArgs = ['--name', `memos-broker-${suffix}`, '--network', network,
    '--network-alias', 'brai-release-nats', '--mount',
    `type=bind,src=${path.join(directory, 'nats.json')},dst=/nats.json,readonly`, brokerImage, '-c', '/nats.json'];
  const responderCode = `import { connect } from 'nats';
    const nc = await connect({servers:'nats://brai-release-nats:4222',user:'responder',pass:'fixture',
      waitOnFirstConnect:true,maxReconnectAttempts:-1});
    const sub = nc.subscribe('brai.local_ai.v1.invoke.embed'); console.log('READY');
    for await (const message of sub) { const value=JSON.parse(new TextDecoder().decode(message.data));
      message.respond(Buffer.from(JSON.stringify({requestId:value.requestId,operationId:value.operationId,
        model:value.model,vectors:value.texts.map(()=>Array(768).fill(0.5))}))); }`;
  const probeCode = `const bad=await fetch('http://memory-embeddings:19573/v1/embeddings',{
    method:'POST',signal:AbortSignal.timeout(3000)});if(bad.status!==401)process.exit(1);
    const r=await fetch('http://memory-embeddings:19573/v1/embeddings',{
    method:'POST',headers:{authorization:'Bearer '+${JSON.stringify('x'.repeat(32))},'content-type':'application/json'},
    body:JSON.stringify({model:'embeddinggemma-2-q8',input:'synthetic test'}),signal:AbortSignal.timeout(3000)});
    const v=await r.json();if(!r.ok||v.data?.[0]?.embedding?.length!==768)process.exit(1);`;
  const probe = (responder) => execFileSync('docker', ['exec', responder, 'node', '--input-type=module', '-e', probeCode],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    networkId = docker('network', 'create', '--label', `org.brai.memos-fixture=${suffix}`, '--internal', network);
    assert.equal(status(networkId, '.Internal'), 'true');
    const config = { ownerId: 'release-memos', nats: { servers: ['nats://brai-release-nats:4222'],
      user: 'release_embeddings', password: 'fixture' }, embedding: { host: '0.0.0.0', port: 19573,
      apiKey: 'x'.repeat(32), model: { modelId: 'embeddinggemma-2-q8',
        revision: 'bfcd298762cc34d0357ece5ebdd31791a3a374d8', profileId: 'embeddinggemma2_llama_cpp' } } };
    const configPath = path.join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(path.join(directory, 'nats.json'), JSON.stringify({ port: 4222, authorization: { users: [
      { user: 'release_embeddings', password: 'fixture', permissions: {
        publish: { allow: ['brai.local_ai.v1.invoke.embed', 'brai.local_ai.v1.status'] },
        subscribe: { allow: ['_INBOX.memos_embedding.>'] } } },
      { user: 'responder', password: 'fixture', permissions: {
        publish: { allow: ['_INBOX.memos_embedding.>'] }, subscribe: { allow: ['brai.local_ai.v1.invoke.embed'] } } },
    ] } }));
    const sourceMount = `type=bind,src=${process.cwd()},dst=/work,readonly`;
    adapter = start('--name', `memos-adapter-${suffix}`, '--network', network,
      '--network-alias', 'memory-embeddings', '--restart', 'unless-stopped',
      '--mount', sourceMount, '--mount', `type=bind,src=${configPath},dst=/config.json,readonly`,
      '--workdir', '/work', '--env', 'BRAI_HERMES_CONFIG=/config.json', image,
      'node', 'services/hermes/memos/embedding/adapter.mjs');
    await wait(() => { if (Number(status(adapter, '.RestartCount')) < 1) throw Error('startup failure not observed'); });
    assert.match(logs(adapter), /MemOS embedding adapter:.*(ENOTFOUND|CONNECTION_REFUSED|ECONNREFUSED)/i);
    let broker = start(...brokerArgs);
    await wait(() => { if (!logs(broker).includes('Server is ready')) throw Error('broker not ready'); });
    let responder = start('--network', network, '--mount', sourceMount, '--workdir', '/work',
      image, 'node', '--input-type=module', '-e', responderCode);
    await wait(() => { if (!logs(responder).includes('READY')) throw Error('responder not ready'); });
    await wait(() => probe(responder));
    assert.equal(status(adapter, '.HostConfig.NetworkMode'), network);
    assert.equal(status(adapter, 'range .NetworkSettings.Networks}}{{.NetworkID}}{{end'), networkId);
    assert.equal(status(broker, 'range .NetworkSettings.Networks}}{{.NetworkID}}{{end'), networkId);
    const ports = JSON.parse(status(adapter, 'json .HostConfig.PortBindings'));
    assert.ok(!ports || Object.keys(ports).length === 0);
    const before = Number(status(adapter, '.RestartCount'));

    docker('pause', adapter);
    docker('stop', '--time', '1', broker);
    docker('start', broker);
    docker('unpause', adapter);
    await wait(() => probe(responder));
    assert.ok(Number(status(adapter, '.RestartCount')) > before, 'adapter must restart after paused broker outage');
    const afterStopStart = Number(status(adapter, '.RestartCount'));

    const oldAddress = status(broker, 'range .NetworkSettings.Networks}}{{.IPAddress}}{{end');
    docker('rm', '-f', broker);
    containers.delete(broker);
    const filler = start('--network', network, image, 'sleep', 'infinity');
    broker = start(...brokerArgs);
    await wait(() => { if (!logs(broker).includes('Server is ready')) throw Error('broker not ready'); });
    const newAddress = status(broker, 'range .NetworkSettings.Networks}}{{.IPAddress}}{{end');
    assert.notEqual(newAddress, oldAddress, 'recreated broker must have a different IP');
    assert.ok(filler);
    await wait(() => probe(responder));
    assert.ok(Number(status(adapter, '.RestartCount')) > afterStopStart, 'adapter must restart after broker replacement');
  } catch (error) {
    testError = error;
  } finally {
    const failures = [];
    try {
      for (const id of docker('ps', '-a', '--no-trunc', '--filter', `label=org.brai.memos-fixture=${suffix}`,
        '--format', '{{.ID}}').split('\n').filter(Boolean)) containers.add(id);
    } catch { failures.push('container discovery'); }
    for (const id of [...containers].reverse()) {
      try {
        if (id === adapter && status(id, '.State.Paused') === 'true') docker('unpause', id);
        docker('rm', '-f', id);
      } catch { failures.push('container'); }
    }
    try {
      const networks = docker('network', 'ls', '--no-trunc', '--filter', `label=org.brai.memos-fixture=${suffix}`,
        '--format', '{{.ID}}').split('\n').filter(Boolean);
      for (const id of networks) {
        try { docker('network', 'rm', id); } catch { failures.push('network'); }
      }
    } catch { failures.push('network'); }
    try { rmSync(directory, { recursive: true, force: true }); } catch { failures.push('temporary directory'); }
    if (failures.length) {
      const cleanupError = Error(`Fixture cleanup failed: ${failures.join(', ')}`);
      if (testError) throw new AggregateError([testError, cleanupError], 'Test and fixture cleanup failed');
      throw cleanupError;
    }
  }
  if (testError) throw testError;
});
