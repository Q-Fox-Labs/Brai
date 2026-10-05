// ABOUTME: Запускает ровно три stdio программы с явными allowlist окружения и owner DTO проверками.
// ABOUTME: Потеря ответа не означает отмену; дочерние процессы не перезапускаются автоматически.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { methodMap, validateDto } from '#transcription-contracts';
import { RpcClient } from '../runtime/stdio-rpc.js';
import type { CoordinatorRuntimeConfig } from './config.js';

/** Создаёт изолированные helper/local/external порты; close завершает только собственные процессы. */
export function spawnCoordinatorChildren(config: Pick<CoordinatorRuntimeConfig,
  'children' | 'rpcFrameBytes' | 'rpcConcurrentRequests' | 'rpcControlTimeoutMs' | 'childShutdownTimeoutMs'>) {
  const children = (['helper', 'local', 'external'] as const).map((name) => {
    const path = name === 'helper' ? '../helper/main.js' : `../executors/${name}/main.js`;
    const child = spawn(process.execPath, [fileURLToPath(new URL(path, import.meta.url))], {
      env: { ...config.children[name] }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Чужой stderr может включать secret/payload; дренируем без журнала и накопления.
    child.stderr.resume();
    const client = new RpcClient({ input: child.stdout, output: child.stdin, process: child }, {
      frameBytes: config.rpcFrameBytes, concurrentRequests: config.rpcConcurrentRequests,
    });
    const port = {
      async call(method: string, params: unknown): Promise<unknown> {
        const pair = Object.hasOwn(methodMap[name], method) ? methodMap[name][method] : undefined;
        if (!pair || !validateDto(pair[0], params)) throw { errorCode: 'INVALID_ARGUMENT', outcome: 'not_started' };
        const deadlineAt = method === 'execute' ? Date.parse((params as { deadlineAt: string }).deadlineAt) : Date.now() + config.rpcControlTimeoutMs;
        const result = await client.call(method, params as Record<string, unknown>, { deadlineAt });
        if (!validateDto(pair[1], result)) throw { errorCode: 'REQUEST_OUTCOME_UNKNOWN', outcome: 'unknown' };
        return result;
      },
    };
    return { name, child, client, port };
  });
  let closing: Promise<void> | undefined;
  return {
    helper: children[0].port, local: children[1].port, external: children[2].port,
    close(): Promise<void> {
      return closing ??= Promise.all(children.map(({ child, client }) => new Promise<void>((resolve) => {
        client.close();
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, config.childShutdownTimeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.once('error', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      }))).then(() => undefined);
    },
  };
}
