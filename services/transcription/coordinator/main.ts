// ABOUTME: Собирает coordinator из трёх дочерних stdio программ, owner портов и публичных transports.
// ABOUTME: Открывает ingress только после recovery; ошибки запуска/остановки не включают credentials или payload.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { connect, type NatsConnection } from 'nats';
import { loadCoordinatorConfig, type CoordinatorRuntimeConfig, type NatsSettings } from './config.js';
import { spawnCoordinatorChildren } from './childspawn.js';
import { createCoordinator } from './domain/core.js';
import { createRecoveryController } from './recovery/controller.js';
import { createDependencyPorts } from './transport/dependencies.js';
import { createPublicGateway } from './transport/boundary.js';
import { startHttpTransport } from './transport/http.js';
import { startNatsTransport } from './transport/nats.js';

function connection(settings: NatsSettings, timeout: number): Promise<NatsConnection> {
  return connect({ ...settings, timeout, reconnect: false });
}

/** Запускает собственные ресурсы, ожидает startup recovery и возвращает идемпотентный close/status. */
export async function startCoordinator(config: CoordinatorRuntimeConfig) {
  const children = spawnCoordinatorChildren(config);
  let nc: NatsConnection | undefined;
  let localAi: NatsConnection | undefined;
  let http: Awaited<ReturnType<typeof startHttpTransport>> | undefined;
  let nats: Awaited<ReturnType<typeof startNatsTransport>> | undefined;
  let recovery: ReturnType<typeof createRecoveryController> | undefined;
  let core: ReturnType<typeof createCoordinator> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // Закрытие channels делает незавершённые вызовы unknown; оно не подтверждает остановку вычисления.
    const stopResources = [http?.close(), recovery?.close(), children.close(), localAi?.close(), nc?.close()];
    await Promise.allSettled(stopResources);
    // SDK service.stop дренирует через PONG; после nc.close он использует безопасный closed fast path.
    await Promise.allSettled([nats?.close()]);
    core?.clearVolatileResults();
  })();
  try {
    const health = await children.helper.call('health', {}) as { available: boolean; storageAvailable: boolean };
    if (!health.available || !health.storageAvailable) throw new Error('Storage unavailable');
    nc = await connection(config.nats, config.dependencyTimeoutMs);
    if (config.localAi) {
      // Недоступность local-ai допускает metadata/readiness, но не превращается в успешный пустой каталог.
      try { localAi = await connection(config.localAi, config.dependencyTimeoutMs); } catch { localAi = undefined; }
    }
    const dependencies = await createDependencyPorts(nc, localAi, config);
    core = createCoordinator({ ports: { helper: children.helper, local: children.local, external: children.external,
      artifacts: dependencies.artifacts, localCatalog: dependencies.localCatalog }, config: config.domain });
    recovery = createRecoveryController({ helper: children.helper, history: dependencies.history,
      clearVolatileResults: core.clearVolatileResults, config: config.recovery });
    await recovery.initialize();
    const gateway = createPublicGateway({ invoke: core.invoke, bindings: config.bindings, maxConcurrent: config.maxPublicConcurrent });
    http = await startHttpTransport(config.http, gateway);
    nats = await startNatsTransport(nc, gateway, { requestBytes: config.natsRequestBytes, responseBytes: config.natsResponseBytes });
    recovery.start(core.pumpOnce);
    return { close, address: http.address,
      async status() {
        const [helperHealth, localExecutor] = await Promise.all([
          children.helper.call('health', {}).catch(() => ({ available: false, storageAvailable: false })),
          children.local.call('health', {}).catch(() => ({ configured: Boolean(config.localAi), verified: false, available: false })),
        ]) as [{ available: boolean; storageAvailable: boolean }, { configured: boolean; verified: boolean; available: boolean }];
        const lifecycle = recovery!.status();
        const metadataReady = !closing && !nc!.isClosed() && lifecycle.ready && helperHealth.available && helperHealth.storageAvailable;
        return { ...lifecycle, metadataReady, localExecutor,
          ready: metadataReady && Boolean(localAi && !localAi.isClosed()) && localExecutor.configured && localExecutor.verified && localExecutor.available };
      },
    };
  } catch {
    await close();
    throw new Error('Transcription coordinator startup failed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      const runtime = await startCoordinator(loadCoordinatorConfig());
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void runtime.close().then(() => { process.exitCode = 0; });
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    } catch {
      process.stderr.write('Transcription coordinator startup failed\n');
      process.exitCode = 1;
    }
  })();
}
