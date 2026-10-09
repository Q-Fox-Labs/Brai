// ABOUTME: Проверяет безопасную загрузку artifacts во временный путь local-ai.
// ABOUTME: Использует собственный NATS mock, loopback HTTP и temp root для каждого сценария.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createArtifactsAdapter } from '../../dist/adapters/artifacts/index.js';

const artifactId = 'f2d85bb3-9a74-48ca-ae1f-1fb140d2cb7f';
const ownerId = 'owner-test';
const bytes = Buffer.from('synthetic test audio');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function setup(options = {}) {
  const audio = options.body ?? bytes;
  let httpRequests = 0;
  const server = createServer((request, response) => {
    httpRequests += 1;
    if (options.responseDelayMs) {
      setTimeout(() => {
        response.writeHead(options.httpStatus ?? 200, options.httpHeaders);
        response.end(audio);
      }, options.responseDelayMs);
      return;
    }
    response.writeHead(options.httpStatus ?? 200, options.httpHeaders);
    response.end(audio);
  });
  const port = await listen(server);
  const internalBaseUrl = 'http://127.0.0.1:' + port;
  const tempRoot = await mkdtemp(join(tmpdir(), 'local-ai-artifacts-test-'));
  const artifact = {
    artifactId,
    ownerId,
    status: 'ready',
    mimeType: 'audio/wav',
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    internalUrl: internalBaseUrl + '/files/opaque-key_1',
    ...options.artifact,
  };
  const headers = {
    get(name) {
      if (name === 'Nats-Service-Error') return options.serviceError ?? null;
      if (name === 'Nats-Service-Error-Code') return options.serviceErrorCode ?? null;
      return null;
    },
  };
  const nats = {
    async request(subject, payload, requestOptions) {
      assert.equal(subject, 'brai.artifacts.v1.get');
      assert.deepEqual(JSON.parse(Buffer.from(payload).toString('utf8')), { artifactId });
      assert.ok(requestOptions.timeout > 0);
      const data = options.replyData ?? Buffer.from(JSON.stringify(artifact));
      return { data, headers };
    },
  };
  const adapter = createArtifactsAdapter({
    nats,
    internalBaseUrl,
    tempRoot,
    maxAudioBytes: options.maxAudioBytes ?? bytes.length,
    allowedMimeTypes: ['audio/wav'],
  });
  const context = (signal = new AbortController().signal) => ({
    ownerId,
    operationId: 'operation-test',
    deadlineAt: new Date(Date.now() + 5000).toISOString(),
    signal,
  });
  return {
    adapter,
    artifact,
    context,
    get httpRequests() { return httpRequests; },
    server,
    tempRoot,
  };
}

async function cleanup(fixture) {
  await close(fixture.server);
  await rm(fixture.tempRoot, { recursive: true, force: true });
}

test('downloads bounded bytes, verifies size/hash, and keeps the file only during callback', async () => {
  const fixture = await setup({ artifact: { artifactId: artifactId.toUpperCase() } });
  try {
    const marker = join(fixture.tempRoot, 'keep-me');
    await writeFile(marker, 'caller data');
    const result = await fixture.adapter.withReadyAudio(
      { artifactId, ownerId, operationId: 'operation-test' },
      fixture.context(),
      async ({ localPath }) => {
        assert.deepEqual(await readFile(localPath), bytes);
        assert.equal((await stat(localPath)).mode & 0o777, 0o600);
        return 'transcribed';
      },
    );
    assert.equal(result, 'transcribed');
    assert.deepEqual(await readdir(fixture.tempRoot), ['keep-me']);
    assert.equal(await readFile(join(fixture.tempRoot, 'keep-me'), 'utf8'), 'caller data');
    assert.equal(fixture.httpRequests, 1);
  } finally {
    await cleanup(fixture);
  }
});

test('missing, foreign, and non-ready artifacts share one safe denial before HTTP', async () => {
  const scenarios = [
    { serviceError: 'NOT_FOUND', serviceErrorCode: '404', replyData: Buffer.from('not JSON') },
    { artifact: { ownerId: 'other-owner' } },
    { artifact: { status: 'pending', sizeBytes: null, sha256: null } },
    { artifact: { status: 'deleted', sizeBytes: 0, sha256: null } },
  ];
  for (const scenario of scenarios) {
    const fixture = await setup(scenario);
    try {
      await assert.rejects(
        fixture.adapter.withReadyAudio(
          { artifactId, ownerId, operationId: 'operation-test' },
          fixture.context(),
          async () => assert.fail('denied artifact reached model callback'),
        ),
        { code: 'ARTIFACT_NOT_AVAILABLE' },
      );
      assert.equal(fixture.httpRequests, 0);
      assert.deepEqual(await readdir(fixture.tempRoot), []);
    } finally {
      await cleanup(fixture);
    }
  }
});

test('rejects non-canonical URLs and redirects without following them', async () => {
  const badUrl = await setup({ artifact: { internalUrl: 'http://127.0.0.1:1/files/key%2fother' } });
  try {
    await assert.rejects(
      badUrl.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        badUrl.context(),
        async () => assert.fail('invalid URL reached callback'),
      ),
      { code: 'DEPENDENCY_UNAVAILABLE' },
    );
    assert.equal(badUrl.httpRequests, 0);
  } finally {
    await cleanup(badUrl);
  }

  const redirect = await setup({ httpStatus: 302, httpHeaders: { location: 'http://127.0.0.1:1/secret' } });
  try {
    await assert.rejects(
      redirect.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        redirect.context(),
        async () => assert.fail('redirect reached callback'),
      ),
      { code: 'DEPENDENCY_UNAVAILABLE' },
    );
    assert.equal(redirect.httpRequests, 1);
    assert.deepEqual(await readdir(redirect.tempRoot), []);
  } finally {
    await cleanup(redirect);
  }
});

test('rejects oversized streams, size/hash mismatches, and cleans its temp directory', async () => {
  const oversized = await setup({ body: Buffer.alloc(bytes.length + 1), maxAudioBytes: bytes.length });
  try {
    await assert.rejects(
      oversized.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        oversized.context(),
        async () => assert.fail('oversized data reached callback'),
      ),
      { code: 'INPUT_TOO_LARGE' },
    );
    assert.deepEqual(await readdir(oversized.tempRoot), []);
  } finally {
    await cleanup(oversized);
  }

  const badHash = await setup({ artifact: { sha256: '0'.repeat(64) } });
  try {
    await assert.rejects(
      badHash.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        badHash.context(),
        async () => assert.fail('bad hash reached callback'),
      ),
      { code: 'DEPENDENCY_UNAVAILABLE' },
    );
    assert.deepEqual(await readdir(badHash.tempRoot), []);
  } finally {
    await cleanup(badHash);
  }

  const badSize = await setup({ artifact: { sizeBytes: bytes.length + 1 }, maxAudioBytes: bytes.length + 2 });
  try {
    await assert.rejects(
      badSize.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        badSize.context(),
        async () => assert.fail('size mismatch reached callback'),
      ),
      { code: 'DEPENDENCY_UNAVAILABLE' },
    );
    assert.deepEqual(await readdir(badSize.tempRoot), []);
  } finally {
    await cleanup(badSize);
  }
});

test('cleans its own temp directory when callback fails or caller cancels download', async () => {
  const callbackFailure = await setup();
  try {
    await assert.rejects(
      callbackFailure.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        callbackFailure.context(),
        async () => { throw new Error('synthetic callback failure'); },
      ),
      /synthetic callback failure/,
    );
    assert.deepEqual(await readdir(callbackFailure.tempRoot), []);
  } finally {
    await cleanup(callbackFailure);
  }

  const cancelled = await setup({ responseDelayMs: 300 });
  try {
    const controller = new AbortController();
    const pending = cancelled.adapter.withReadyAudio(
      { artifactId, ownerId, operationId: 'operation-test' },
      cancelled.context(controller.signal),
      async () => assert.fail('cancelled download reached callback'),
    );
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, { code: 'CANCELLED' });
    assert.deepEqual(await readdir(cancelled.tempRoot), []);
  } finally {
    await cleanup(cancelled);
  }

  const expired = await setup({ responseDelayMs: 300 });
  try {
    const context = expired.context();
    context.deadlineAt = new Date(Date.now() + 25).toISOString();
    await assert.rejects(
      expired.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        context,
        async () => assert.fail('expired download reached callback'),
      ),
      { code: 'DEADLINE_EXCEEDED' },
    );
    assert.deepEqual(await readdir(expired.tempRoot), []);
  } finally {
    await cleanup(expired);
  }
});

test('requires exact HTTP 200 and operation context identity', async () => {
  const partial = await setup({ httpStatus: 206 });
  try {
    await assert.rejects(
      partial.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'operation-test' },
        partial.context(),
        async () => assert.fail('partial range reached callback'),
      ),
      { code: 'DEPENDENCY_UNAVAILABLE' },
    );
    assert.deepEqual(await readdir(partial.tempRoot), []);
  } finally {
    await cleanup(partial);
  }

  const identity = await setup();
  try {
    await assert.rejects(
      identity.adapter.withReadyAudio(
        { artifactId, ownerId, operationId: 'different-operation' },
        identity.context(),
        async () => assert.fail('mismatched operation reached callback'),
      ),
      { code: 'INVALID_ARGUMENT' },
    );
    assert.equal(identity.httpRequests, 0);
  } finally {
    await cleanup(identity);
  }
});


test('media acquisition checks requested kind, owner and hash before exposing its private file', async () => {
  for (const [kind, mimeType] of [['image_artifact','image/png'],['audio_artifact','audio/wav'],['video_artifact','video/mp4']]) {
    const fixture = await setup({ artifact: { mimeType } });
    try {
      await fixture.adapter.withReadyMedia({ artifactId, ownerId, operationId: 'operation-test', kind }, fixture.context(), async media => {
        assert.equal(media.mimeType, mimeType);
        assert.deepEqual(await readFile(media.localPath), bytes);
      });
      assert.deepEqual(await readdir(fixture.tempRoot), []);
    } finally { await cleanup(fixture); }
  }
  const foreign = await setup({ artifact: { mimeType: 'image/png', ownerId: 'foreign' } });
  try {
    await assert.rejects(foreign.adapter.withReadyMedia({ artifactId, ownerId, operationId: 'operation-test', kind: 'image_artifact' }, foreign.context(), () => assert.fail('foreign file exposed')), error => error.code === 'ARTIFACT_NOT_AVAILABLE');
    assert.equal(foreign.httpRequests, 0);
  } finally { await cleanup(foreign); }
});
