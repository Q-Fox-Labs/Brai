// ABOUTME: Запускает независимый local executor по stdin/stdout JSON-RPC.
// ABOUTME: Загружает только опубликованный owner contract и закрывает собственное NATS соединение.
import { createLocalExecutor } from './adapter.js';
import { loadLocalExecutorConfig } from './config.js';
import { createLocalAiConnectionProvider } from './nats.js';
import { serveRpc } from '../../runtime/stdio-rpc.js';

async function main(): Promise<void> {
  const config = loadLocalExecutorConfig();
  const contracts = await import(new URL('../../local-ai/contracts/index.mjs', import.meta.resolve('#transcription-contracts')).href);
  const provider = createLocalAiConnectionProvider(config);
  const executor = createLocalExecutor(provider, contracts, config.controlTimeoutMs, config.responseBytes, config.hopTimeoutMs);
  let stopping = false;
  const stopInput = () => {
    if (stopping) return;
    stopping = true;
    process.stdin.destroy();
    void provider.close();
  };
  process.once('SIGINT', stopInput);
  process.once('SIGTERM', stopInput);
  try {
    await serveRpc(executor.methods, executor.handlers, {
      ...config.rpc,
      applicationErrorCodes: executor.applicationErrorCodes,
    });
  } catch {
    process.stderr.write('LOCAL_EXECUTOR_RPC_FAILED\n');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stopInput);
    process.off('SIGTERM', stopInput);
    await provider.close();
  }
}

try { await main(); }
catch { process.stderr.write('LOCAL_EXECUTOR_START_FAILED\n'); process.exitCode = 1; }
