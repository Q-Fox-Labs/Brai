// ABOUTME: Собирает Codex, native application и NATS Services в один процесс.
// ABOUTME: Читает явную JSON конфигурацию, закрывает только свои подключения.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect, headers, ServiceErrorHeader, ServiceErrorCodeHeader, type NatsConnection } from 'nats';
import { createArtifactsPort, type ArtifactsPort } from './attachments.js';
import { createCodex } from './codex.js';
import { openReadState } from './read-state.js';
import { createApplication, type Config } from './application.js';
import { subjects, bytes, limits } from '../contracts/index.mjs';
import type { Command, EventEnvelope } from '../contracts/index.mjs';
/** Запускает собственные подключения; рестарт agent не перезапускает app-server. */
export async function startAgent(config: Config) {
  if (!config.codex?.socketUrl || !config.nats?.servers?.length || !config.projects?.length || config.projects.some(p => !p.projectId || !p.cwd.startsWith('/')) || new Set(config.projects.map(p => p.projectId)).size !== config.projects.length) throw new Error('INVALID_AGENT_CONFIG');
  if (config.artifacts) {
    if (config.artifacts.resultsNats && (!config.artifacts.resultsNats.servers?.length || config.artifacts.resultsNats.servers.some(server => typeof server !== 'string' || !server))) throw new Error('INVALID_AGENT_CONFIG');
    if (config.artifacts.resultsBaseUrl) {
      const resultsBase = new URL(config.artifacts.resultsBaseUrl);
      if (!['http:', 'https:'].includes(resultsBase.protocol) || resultsBase.username || resultsBase.password || resultsBase.search || resultsBase.hash) throw new Error('INVALID_AGENT_CONFIG');
    }
    if (config.artifacts.nats && (!config.artifacts.nats.servers?.length || config.artifacts.nats.servers.some(server => typeof server !== 'string' || !server))) throw new Error('INVALID_AGENT_CONFIG');
    const base = new URL(config.artifacts.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || config.artifacts.timeoutMs !== undefined && (!Number.isSafeInteger(config.artifacts.timeoutMs) || config.artifacts.timeoutMs < 1 || config.artifacts.timeoutMs > 10000)) throw new Error('INVALID_AGENT_CONFIG');
  }
  if (config.readStatePath !== undefined && (!config.readStatePath.startsWith('/') || !config.ownerId)) throw new Error('INVALID_AGENT_CONFIG');
  const readState = config.readStatePath ? await openReadState(config.readStatePath) : undefined;
  const codex = createCodex(config.codex);
  const nc = await connect({ ...config.nats, pass: config.nats.password, inboxPrefix: config.nats.inboxPrefix ?? '_INBOX.brai_agent', maxReconnectAttempts: -1 }).catch(async error => { await readState?.close(); await codex.close(); throw error; });
  const service = await nc.services.add({ name: 'brai_agent', version: '3.0.0', queue: 'brai_agent' });
  let closed = false, brokerConnected = true, sending = false, activeRequests = 0;
  let artifactsNc: NatsConnection | undefined, artifactsConnecting: Promise<void> | undefined;
  let resultsNc: NatsConnection | undefined, resultsConnecting: Promise<void> | undefined;
  let artifactsConnected = false;
  let resultsConnected = false;
  async function connectResults() {
    if (!config.artifacts?.resultsNats || resultsNc && !resultsNc.isClosed() || closed) return;
    if (resultsConnecting) return resultsConnecting;
    resultsConnecting = (async () => {
      try {
        const settings = config.artifacts!.resultsNats!;
        const connection = await connect({ ...settings, pass: settings.password, inboxPrefix: settings.inboxPrefix ?? '_INBOX.brai_agent_results', timeout: 1000, maxReconnectAttempts: -1 });
        if (closed) await connection.close(); else {
          resultsNc = connection; resultsConnected = true;
          void (async () => { for await (const event of connection.status()) {
            if (event.type === 'disconnect') resultsConnected = false;
            if (event.type === 'reconnect') resultsConnected = true;
          } })();
        }
      } catch { /* Outgoing metadata недоступна; incoming transport остаётся независимым. */ }
    })().finally(() => { resultsConnecting = undefined; });
    return resultsConnecting;
  }
  async function connectArtifacts() {
    if (!config.artifacts?.nats || artifactsNc && !artifactsNc.isClosed() || closed) return;
    if (artifactsConnecting) return artifactsConnecting;
    artifactsConnecting = (async () => {
      try {
        const settings = config.artifacts!.nats!;
        const connection = await connect({ ...settings, pass: settings.password, inboxPrefix: settings.inboxPrefix ?? '_INBOX.brai_agent_artifacts', timeout: 1000, maxReconnectAttempts: -1 });
        if (closed) await connection.close(); else {
          artifactsNc = connection; artifactsConnected = true;
          void (async () => { for await (const event of connection.status()) {
            if (event.type === 'disconnect') artifactsConnected = false;
            if (event.type === 'reconnect') artifactsConnected = true;
          } })();
        }
      } catch { /* Резервирование запрещает send, пока отдельный broker недоступен. */ }
    })().finally(() => { artifactsConnecting = undefined; });
    return artifactsConnecting;
  }
  await connectArtifacts();
  await connectResults();
  const artifactsPort: ArtifactsPort = config.artifacts?.nats ? {
    fetch: globalThis.fetch,
    async request(subject, value, options) {
      if (!artifactsNc || artifactsNc.isClosed() || !artifactsConnected) throw Object.assign(new Error('UPSTREAM_UNAVAILABLE'), { code: 'UPSTREAM_UNAVAILABLE', outcome: 'not-sent' });
      return createArtifactsPort(artifactsNc, config.artifacts?.timeoutMs).request(subject, value, options);
    },
  } : createArtifactsPort(nc, config.artifacts?.timeoutMs);
  const resultsPort: ArtifactsPort = config.artifacts?.resultsNats ? {
    fetch: globalThis.fetch,
    async request(subject, value, options) {
      if (!resultsNc || resultsNc.isClosed() || !resultsConnected) throw Object.assign(new Error('UPSTREAM_UNAVAILABLE'), { code: 'UPSTREAM_UNAVAILABLE', outcome: 'query' });
      return createArtifactsPort(resultsNc, config.artifacts?.timeoutMs).request(subject, value, options);
    },
  } : artifactsPort;
  const queue = new Map<string, EventEnvelope>();
  async function drain() {
    if (sending) return;
    sending = true;
    let inFlight: EventEnvelope | undefined;
    try {
      while (!closed && brokerConnected && queue.size) {
        const key = queue.keys().next().value!;
        const event = queue.get(key)!;
        inFlight = event;
        queue.delete(key);
        nc.publish(subjects.event, Buffer.from(JSON.stringify(event)));
        await nc.flush();
        inFlight = undefined;
      }
    } catch { if (inFlight && !queue.has(inFlight.threadId)) queue.set(inFlight.threadId, inFlight); }
    finally { sending = false; }
  }
  const app = createApplication(codex, config, event => {
    if (closed || !brokerConnected) return;
    const key = event.threadId, old = queue.get(key);
    if (old) queue.delete(key);
    if (queue.size >= limits.queue) {
      queue.clear();
      codex.invalidate();
      return;
    }
    queue.set(key, event);
    void drain();
  }, artifactsPort, resultsPort, readState);
  const codes: Record<string, number> = { INVALID_ARGUMENT: 400, REQUEST_TOO_LARGE: 413, ITEM_TOO_LARGE: 413, STALE_GENERATION: 409, STALE_ITEM: 409, STALE_REQUEST: 409, OPERATION_CONFLICT: 409, CAPACITY_EXHAUSTED: 503, UPSTREAM_UNAVAILABLE: 503, TIMEOUT: 504, NOT_FOUND: 404, UNSUPPORTED: 501 };
  service.addEndpoint('rpc', { subject: subjects.rpc, handler: (_error, message) => {
    void (async () => {
      let admitted = false;
      try {
        if (message.data.length > limits.input) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { code: 'REQUEST_TOO_LARGE', outcome: 'not-sent' });
        if (activeRequests >= limits.pending) throw Object.assign(new Error('CAPACITY_EXHAUSTED'), { code: 'CAPACITY_EXHAUSTED', outcome: 'not-sent' });
        activeRequests++;
        admitted = true;
        const value = await app.request(JSON.parse(Buffer.from(message.data).toString()) as Command);
        if (bytes(value) > limits.state) throw Object.assign(new Error('CAPACITY_EXHAUSTED'), { code: 'CAPACITY_EXHAUSTED', outcome: 'query' });
        message.respond(Buffer.from(JSON.stringify(value)));
      } catch (error: any) {
        const code = Object.hasOwn(codes, error?.code) ? error.code : 'UPSTREAM_UNAVAILABLE', outcome = ['not-sent', 'query', 'unknown'].includes(error?.outcome) ? error.outcome : 'unknown';
        const h = headers();
        h.set(ServiceErrorHeader, code);
        h.set(ServiceErrorCodeHeader, String(codes[code]));
        message.respond(Buffer.from(JSON.stringify({ code, outcome, ...(Number.isSafeInteger(error?.upstreamCode) ? { upstreamCode: error.upstreamCode } : {}) })), { headers: h });
      } finally { if (admitted) activeRequests--; }
    })();
  } });
  const timer = setInterval(() => { if (!closed) { void codex.connect().catch(() => {}); void connectArtifacts(); void connectResults(); void drain(); } }, 1000);
  void (async () => { for await (const event of nc.status()) { if (event.type === 'disconnect') { brokerConnected = false; queue.clear(); } if (event.type === 'reconnect') brokerConnected = true; } })();
  await codex.connect().catch(() => {});
  return { status: () => codex.status(), async close() {
    if (closed) return;
    closed = true; clearInterval(timer); app.close();
    const results = await Promise.allSettled([readState?.close(), service.stop(), codex.close(), artifactsNc?.close(), artifactsConnecting, resultsNc?.close(), resultsConnecting]);
    await nc.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.BRAI_AGENT_CONFIG?.startsWith('/')) throw new Error('BRAI_AGENT_CONFIG_REQUIRED');
  const config = JSON.parse(await readFile(process.env.BRAI_AGENT_CONFIG, 'utf8')) as Config;
  const agent = await startAgent(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void agent.close().finally(() => process.exit()); });
}
