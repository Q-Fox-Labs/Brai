// ABOUTME: Проверяет восстановление прежнего адаптера после остановки NATS при бэкапе.
// ABOUTME: Использует неизменённый Git-снимок, отдельные контейнеры и синтетический вектор.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = async (operation) => {
  let error;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { return operation(); } catch (cause) { error = cause; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw error;
};

test('legacy adapter can rejoin the restarted broker without changing its container',
  { skip: process.env.MEMOS_DOCKER_TEST !== '1' }, async () => {
    const suffix = randomUUID();
    const network = `memos-legacy-${suffix}`;
    const directory = mkdtempSync(path.join(tmpdir(), 'memos-legacy-'));
    const image = 'node:24.22.1-bookworm-slim';
    const marker = `org.brai.memos-legacy-fixture=${suffix}`;
    const containers = new Set();
    let adapter;
    let failure;
    const start = (...args) => {
      const id = docker('create', '--label', marker, ...args);
      containers.add(id);
      docker('start', id);
      return id;
    };
    const status = (id, field) => docker('inspect', '--format', `{{${field}}}`, id);
    const logs = (id) => {
      const result = spawnSync('docker', ['logs', id], { encoding: 'utf8', timeout: 120000 });
      if (result.error || result.status !== 0) throw Error('Cannot read fixture logs');
      return result.stdout + result.stderr;
    };
    const modulePath = 'services/hermes/memos/embedding/adapter.mjs';
    const sourceMount = `type=bind,src=${process.cwd()},dst=/work,readonly`;
    const readNamespace = (id) => docker('exec', id, 'node', '--input-type=module', '-e',
      "import {readlinkSync} from 'node:fs'; console.log(readlinkSync('/proc/self/ns/net'))");
    const probeCode = `const r=await fetch('http://brai-release-nats:19573/v1/embeddings',{
      method:'POST',headers:{authorization:'Bearer '+${JSON.stringify('x'.repeat(32))},'content-type':'application/json'},
      body:JSON.stringify({model:'embeddinggemma-2-q8',input:'synthetic backup test'}),signal:AbortSignal.timeout(3000)});
      const v=await r.json();if(!r.ok||v.data?.[0]?.embedding?.length!==768)process.exit(1);`;
    const probe = (id) => execFileSync('docker', ['exec', id, 'node', '--input-type=module', '-e', probeCode],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      docker('network', 'create', '--label', marker, '--internal', network);
      const configPath = path.join(directory, 'config.json');
      const legacyPath = path.join(directory, 'adapter.mjs');
      const config = { ownerId: 'release-memos', nats: { servers: ['nats://127.0.0.1:4222'] },
        embedding: { host: '0.0.0.0', port: 19573, apiKey: 'x'.repeat(32),
          model: { modelId: 'embeddinggemma-2-q8', revision: 'bfcd298762cc34d0357ece5ebdd31791a3a374d8',
            profileId: 'embeddinggemma2_llama_cpp' } } };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o444 });
      // Базовый файл берётся из принятого RELEASE, а не из проверяемого нового адаптера.
      const old = execFileSync('git', ['show', `5a6dec0c3b833b7aba3565e937afc855e6f71964:${modulePath}`]);
      writeFileSync(legacyPath, old, { mode: 0o444 });
      chmodSync(configPath, 0o444);
      chmodSync(legacyPath, 0o444);
      const broker = start('--network', network, '--network-alias', 'brai-release-nats', 'nats:2.15.0');
      await wait(() => { if (!logs(broker).includes('Server is ready')) throw Error('broker not ready'); });
      const responderCode = `import {connect} from 'nats';
        const nc=await connect({servers:'nats://brai-release-nats:4222',waitOnFirstConnect:true,maxReconnectAttempts:-1});
        const sub=nc.subscribe('brai.local_ai.v1.invoke.embed');console.log('READY');
        for await(const m of sub){const v=JSON.parse(new TextDecoder().decode(m.data));
          m.respond(Buffer.from(JSON.stringify({requestId:v.requestId,operationId:v.operationId,model:v.model,
            vectors:v.texts.map(()=>Array(768).fill(0.5))})));}`;
      const responder = start('--network', network, '--mount', sourceMount, '--workdir', '/work', image,
        'node', '--input-type=module', '-e', responderCode);
      await wait(() => { if (!logs(responder).includes('READY')) throw Error('responder not ready'); });
      adapter = start('--network', `container:${broker}`, '--user', '1000:1000', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init', '--mount', sourceMount,
        '--mount', `type=bind,src=${legacyPath},dst=/work/${modulePath},readonly`,
        '--mount', `type=bind,src=${configPath},dst=/config.json,readonly`, '--workdir', '/work',
        '--env', 'BRAI_HERMES_CONFIG=/config.json', image, 'node', modulePath);
      await wait(() => probe(responder));
      docker('pause', adapter);
      docker('stop', '--time', '1', broker);
      docker('start', broker);
      docker('unpause', adapter);
      await wait(() => { if (!logs(broker).includes('Server is ready')) throw Error('broker not ready'); });
      const before = readNamespace(adapter);
      const current = docker('run', '--rm', '--label', marker, '--network', `container:${broker}`, image,
        'node', '--input-type=module', '-e',
        "import {readlinkSync} from 'node:fs'; console.log(readlinkSync('/proc/self/ns/net'))");
      assert.notEqual(before, current, 'backup must reproduce the stale network namespace');
      assert.throws(() => probe(responder));
      docker('restart', '--time', '1', adapter);
      assert.equal(status(adapter, '.Id'), adapter, 'restart must retain the journaled container ID');
      assert.equal(readNamespace(adapter), current);
      await wait(() => probe(responder));
      // Проверка повторного входа после обрыва между stop и start.
      docker('stop', '--time', '1', adapter);
      docker('start', adapter);
      assert.equal(status(adapter, '.Id'), adapter);
      assert.equal(readNamespace(adapter), current);
      await wait(() => probe(responder));
    } catch (error) {
      failure = error;
    } finally {
      const errors = [];
      try {
        for (const id of docker('ps', '-a', '--no-trunc', '--filter', `label=${marker}`,
          '--format', '{{.ID}}').split('\n').filter(Boolean)) containers.add(id);
      } catch { errors.push('container discovery'); }
      for (const id of [...containers].reverse()) {
        try {
          if (id === adapter && status(id, '.State.Paused') === 'true') docker('unpause', id);
          docker('rm', '-f', id);
        } catch { errors.push('container'); }
      }
      try {
        for (const id of docker('network', 'ls', '--no-trunc', '--filter', `label=${marker}`,
          '--format', '{{.ID}}').split('\n').filter(Boolean)) docker('network', 'rm', id);
      } catch { errors.push('network'); }
      try { rmSync(directory, { recursive: true, force: true }); } catch { errors.push('temporary directory'); }
      if (errors.length) {
        const cleanup = Error(`Fixture cleanup failed: ${errors.join(', ')}`);
        if (failure) throw new AggregateError([failure, cleanup], 'Test and fixture cleanup failed');
        throw cleanup;
      }
    }
    if (failure) throw failure;
  });
