// ABOUTME: Собирает Codex, native application и NATS Services в один процесс.
// ABOUTME: Читает явную JSON конфигурацию, закрывает только свои подключения.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect, headers, ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';
import { createArtifactsPort } from './attachments.js';
import { createCodex } from './codex.js';
import { createApplication, type Config } from './application.js';
import { subjects, bytes, limits } from '../contracts/index.mjs';
import type { Command, EventEnvelope } from '../contracts/index.mjs';
/** Запускает собственные подключения; рестарт agent не перезапускает app-server. */
export async function startAgent(config: Config) {
  if (!config.codex?.socketUrl || !config.nats?.servers?.length || !config.projects?.length || config.projects.some(p => !p.projectId || !p.cwd.startsWith('/')) || new Set(config.projects.map(p => p.projectId)).size !== config.projects.length) throw new Error('INVALID_AGENT_CONFIG');
  if (config.artifacts) {
    const base = new URL(config.artifacts.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || config.artifacts.timeoutMs !== undefined && (!Number.isSafeInteger(config.artifacts.timeoutMs) || config.artifacts.timeoutMs < 1 || config.artifacts.timeoutMs > 10000)) throw new Error('INVALID_AGENT_CONFIG');
  }
  const codex = createCodex(config.codex);
  const nc = await connect({ ...config.nats, pass: config.nats.password, inboxPrefix: config.nats.inboxPrefix ?? '_INBOX.brai_agent', maxReconnectAttempts: -1 });
  const service = await nc.services.add({ name: 'brai_agent', version: '3.0.0', queue: 'brai_agent' });
  let closed = false, brokerConnected = true, sending = false, activeRequests = 0;
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
  }, createArtifactsPort(nc, config.artifacts?.timeoutMs));
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
  const timer = setInterval(() => { if (!closed) { void codex.connect().catch(() => {}); void drain(); } }, 1000);
  void (async () => { for await (const event of nc.status()) { if (event.type === 'disconnect') { brokerConnected = false; queue.clear(); } if (event.type === 'reconnect') brokerConnected = true; } })();
  await codex.connect().catch(() => {});
  return { status: () => codex.status(), async close() { closed = true; clearInterval(timer); app.close(); await service.stop(); await codex.close(); await nc.close(); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.BRAI_AGENT_CONFIG?.startsWith('/')) throw new Error('BRAI_AGENT_CONFIG_REQUIRED');
  const config = JSON.parse(await readFile(process.env.BRAI_AGENT_CONFIG, 'utf8')) as Config;
  const agent = await startAgent(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void agent.close().finally(() => process.exit()); });
}
