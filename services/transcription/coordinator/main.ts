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
import { canSend, startNatsTransport } from './transport/nats.js';
import { createAlertsPublisher } from './transport/alerts.js';
import { createAlertsController } from './recovery/alerts.js';

/** Подключает NATS и восстанавливает соединение после обрыва без повтора запросов. */
export function connection(settings: NatsSettings, timeout: number): Promise<NatsConnection> {
  return connect({ ...settings, timeout, maxReconnectAttempts: -1 });
}

/** Повторяет неудачное начальное подключение при следующей проверке, без повтора вычисления. */
export function createLocalConnectionProvider(settings:NatsSettings|undefined, timeout:number,
  open:(settings:NatsSettings, timeout:number)=>Promise<NatsConnection> = connection) {
  let current:NatsConnection|undefined, opening:Promise<NatsConnection|undefined>|undefined, closed=false, connected=false;
  const get = async ():Promise<NatsConnection|undefined> => {
    if (!settings || closed) return undefined;
    if (current && !current.isClosed()) return current;
    if (!opening) opening = open(settings, timeout).then((value) => {
      current = value; connected = true;
      void (async () => {
        try {for await (const event of value.status()) {
          if (current !== value) break;
          if (event.type === 'disconnect') connected = false;
          if (event.type === 'reconnect') connected = true;
        }} finally {if (current === value) connected = false;}
      })().catch(() => {if (current === value) connected = false;});
      return value;
    }).catch(() => undefined).finally(() => { opening = undefined; });
    return opening;
  };
  return {get, ready:()=>Boolean(!closed && connected && current && canSend(current)),
    async close(){closed=true;await opening;await current?.close();}};
}

/** Запускает собственные ресурсы, ожидает startup recovery и возвращает идемпотентный close/status. */
export async function startCoordinator(config: CoordinatorRuntimeConfig) {
  const children = spawnCoordinatorChildren(config);
  const publisher = createAlertsPublisher(config.nats, config.dependencyTimeoutMs);
  const alerts = createAlertsController({ helper: children.helper, publish: publisher.publish,
    workerId: config.domain.workerId, pollIntervalMs: config.recovery.historyPollIntervalMs });
  const helper = children.helper;
  alerts.start();
  let nc: NatsConnection | undefined;
  const local = createLocalConnectionProvider(config.localAi, config.dependencyTimeoutMs);
  let natsConnected = false;
  const watch = (connection: NatsConnection, update: (connected: boolean) => void) => {
    update(true);
    void (async () => {
      try {
        for await (const event of connection.status()) {
          if (event.type === 'disconnect') update(false);
          if (event.type === 'reconnect') update(true);
        }
      } finally { update(false); }
    })().catch(() => update(false));
  };
  let http: Awaited<ReturnType<typeof startHttpTransport>> | undefined;
  let nats: Awaited<ReturnType<typeof startNatsTransport>> | undefined;
  let recovery: ReturnType<typeof createRecoveryController> | undefined;
  let core: ReturnType<typeof createCoordinator> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // Закрытие channels делает незавершённые вызовы unknown; оно не подтверждает остановку вычисления.
    await alerts.close();
    await publisher.close();
    const stopResources = [http?.close(), recovery?.close(), children.close(), local.close(), nc?.close()];
    await Promise.allSettled(stopResources);
    // SDK service.stop дренирует через PONG; после nc.close он использует безопасный closed fast path.
    await Promise.allSettled([nats?.close()]);
    core?.clearVolatileResults();
  })();
  try {
    const health = await helper.call('health', {}) as { available: boolean; storageAvailable: boolean };
    if (!health.storageAvailable) throw new Error('Storage unavailable');
    if ('capacityAvailable' in health && health.capacityAvailable) alerts.observe('capacity', true);
    try { nc = await connection(config.nats, config.dependencyTimeoutMs); }
    catch { throw new Error('NATS unavailable'); }
    watch(nc, (state) => { natsConnected = state; });
    // Неуспешный первоначальный connect можно повторить при следующем чтении каталога.
    await local.get();
    const dependencies = await createDependencyPorts(nc, local.get, config);
    core = createCoordinator({ ports: { helper, local: children.local, external: children.external,
      artifacts: dependencies.artifacts, localCatalog: dependencies.localCatalog },
      config: config.domain, observe: alerts.observe });
    recovery = createRecoveryController({ helper, history: dependencies.history, observe: alerts.observe,
      // AIDEV-NOTE: Фоновые проверки могут закрыть эпизод, но только реальная операция открывает его.
      probe: async () => {
        const storage = await helper.call('health', {}) as { storageAvailable: boolean; capacityAvailable?: boolean };
        if (storage.storageAvailable) alerts.observe('storage', true);
        if (storage.storageAvailable && storage.capacityAvailable) alerts.observe('capacity', true);
        const executor = await children.local.call('health', {}).catch(() => ({ available: false })) as { available: boolean };
        if (executor.available) alerts.observe('local_ai', true);
      },
      clearVolatileResults: core.clearVolatileResults, config: config.recovery });
    await recovery.initialize();
    const localHealth = await children.local.call('health', {}).catch(() => ({ available: false })) as { available: boolean };
    if (localHealth.available) alerts.observe('local_ai', true);
    const gateway = createPublicGateway({ invoke: core.invoke, bindings: config.bindings, maxConcurrent: config.maxPublicConcurrent });
    const status = async () => {
      await local.get();
      const [helperHealth, localExecutor] = await Promise.all([
        children.helper.call('health', {}).catch(() => ({ available: false, storageAvailable: false })),
        children.local.call('health', {}).catch(() => ({ configured: Boolean(config.localAi), verified: false, available: false })),
      ]) as [{ available: boolean; storageAvailable: boolean }, { configured: boolean; verified: boolean; available: boolean }];
      const lifecycle = recovery!.status();
      const metadataReady = !closing && natsConnected && canSend(nc!) && lifecycle.ready && helperHealth.available && helperHealth.storageAvailable;
      return { ...lifecycle, ...alerts.status(), metadataReady, localExecutor,
        ready: metadataReady && local.ready() && localExecutor.configured && localExecutor.verified && localExecutor.available };
    };
    http = await startHttpTransport(config.http, gateway, async () => (await status()).ready);
    nats = await startNatsTransport(nc, gateway, { requestBytes: config.natsRequestBytes, responseBytes: config.natsResponseBytes });
    recovery.start(core.pumpOnce);
    return { close, address: http.address, status };
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
