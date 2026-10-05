// ABOUTME: Запускает local handlers и общий RPC transport как дочерний процесс в тестах.
// ABOUTME: Owner request double позволяет проверить control lane без подмены production runtime.
import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createLocalExecutor } from '../../dist/executors/local/adapter.js';
import { serveRpc } from '../../dist/runtime/stdio-rpc.js';
import * as contracts from '../../../local-ai/contracts/index.mjs';

const model = { modelId: 'whisper/local:large-v3', revision: 'sha256:0123456789abcdef', profileId: 'transcribe/ggml' };
const component = { state: 'ready', errorCode: null };
const status = {
  state: 'ready',
  components: { database: component, nats: component, executables: component, weights: component, history: component, outbox: component },
  outboxCounts: { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null },
};
let release;
const released = new Promise((resolve) => { release = resolve; });
const controlInput = createReadStream(null, { fd: 3, autoClose: false });
const control = createInterface({ input: controlInput });
control.once('line', (line) => {
  if (line === 'release') {
    release();
    control.close();
    controlInput.destroy();
  }
});

const provider = {
  configured: true,
  async getConnection() {
    return {
      isClosed: () => false,
      isDraining: () => false,
      async close() {},
      async request(subject, data) {
        const request = JSON.parse(Buffer.from(data).toString('utf8'));
        if (subject === contracts.subjects.status) return { data: Buffer.from(JSON.stringify(status)), headers: { get: () => '' } };
        writeSync(4, 'invoke-started\n');
        await released;
        return { data: Buffer.from(JSON.stringify({
          requestId: request.operationId,
          operationId: request.operationId,
          model,
          durationMs: 8,
          text: 'fixture transcript',
          segments: null,
        })), headers: { get: () => '' } };
      },
    };
  },
};
const executor = createLocalExecutor(provider, contracts, 1000, 4096, 1000);
await serveRpc(executor.methods, executor.handlers, {
  frameBytes: 4096,
  batchItems: 8,
  concurrentRequests: 3,
  concurrentExecute: 1,
  applicationErrorCodes: executor.applicationErrorCodes,
});
control.close();
controlInput.destroy();
