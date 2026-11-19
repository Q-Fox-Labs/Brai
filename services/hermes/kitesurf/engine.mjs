// ABOUTME: Запускает локальный движок Kitesurf с публичным сетевым relay.
// ABOUTME: Отдельные UID, сетевое пространство и защищённые пути задаёт установщик.
import { lstat, readdir, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { kitesurfOutbound } from '../identity/kitesurf_outbound.mjs';

const { KITESURF_BUNDLE_ROOT: bundle, KITESURF_ASSET_ROOT: assets,
        KITESURF_CDP_SOCKET: socket } = process.env;
if (![bundle, assets, socket].every(value => typeof value === 'string' && path.isAbsolute(value))) {
  throw new Error('Kitesurf paths are required');
}
const port = 19365;
const proxy = new ProxyAgent({uri: 'http://127.0.0.1:18081', proxyTunnel: false});
const modules = [{type: 'ESModule', path: path.join(bundle, 'index.js')}];
for (const name of await readdir(bundle)) {
  if (/\.(wasm|glue\.js|css|dat)$/.test(name)) {
    modules.push({type: name.endsWith('.wasm') ? 'CompiledWasm' : 'Text', path: path.join(bundle, name)});
  }
}
const options = convertV4MiniflareOptions({
  host: '127.0.0.1', port, name: 'brai-kitesurf', modulesRoot: bundle, modules,
  cf: false,
  compatibilityDate: '2026-09-11', compatibilityFlags: ['global_fetch_strictly_public'],
  workerLoaders: {LOADER: {}},
  serviceBindings: {FONT_ASSETS: {disk: {path: assets, writable: false}}},
  bindings: {KITESURF_ENV: 'local', KITESURF_VERSION: 'brai', KITESURF_ALLOW_PRIVATE_NETWORK: ''},
  outboundService: kitesurfOutbound(proxyFetch, proxy),
});
const engine = new Miniflare(options);
await engine.ready;
const bridge = net.createServer(client => {
  const upstream = net.connect(port, '127.0.0.1');
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream).pipe(client);
});
// AIDEV-NOTE: После аварии службы удаляем только её прежний Unix-сокет.
process.umask(0o117);
try {
  const oldSocket = await lstat(socket);
  if (!oldSocket.isSocket()) throw new Error('Kitesurf socket path is occupied');
  await unlink(socket);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await new Promise((resolve, reject) => {
  bridge.once('error', reject);
  bridge.listen(socket, resolve);
});
if (process.env.NOTIFY_SOCKET) execFileSync('/usr/bin/systemd-notify', ['--ready']);
const stop = async () => {
  bridge.close();
  await engine.dispose();
  await proxy.close();
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
