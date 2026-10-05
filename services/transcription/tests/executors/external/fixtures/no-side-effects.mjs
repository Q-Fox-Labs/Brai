// ABOUTME: Запрещает сеть, дочерние процессы и файловую запись при проверке внешнего исполнителя.
// ABOUTME: Guards действуют только в отдельном тестовом процессе; попытка фиксируется даже после catch.
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import childProcess from 'node:child_process';

let forbiddenExit = 0;
function forbidden(kind) {
  forbiddenExit = kind === 'STORAGE' ? 91 : 90;
  process.stderr.write(`EXTERNAL_${kind}_ATTEMPT\n`);
  throw new Error(`External acceptance forbids ${kind}`);
}
function guard(target, names, kind = 'NETWORK') {
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = () => forbidden(kind);
  }
}

globalThis.fetch = () => forbidden('NETWORK');
guard(http, ['request', 'get']);
guard(https, ['request', 'get']);
guard(net, ['connect', 'createConnection']);
guard(net.Socket.prototype, ['connect']);
guard(tls, ['connect']);
guard(dgram, ['createSocket']);
guard(dgram.Socket.prototype, ['send', 'connect']);
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  guard(target, Object.getOwnPropertyNames(target).filter((name) => /^(lookup|resolve|reverse)/.test(name)));
}
guard(childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
guard(fs, ['write', 'writeSync', 'writev', 'writevSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'createWriteStream', 'truncate', 'truncateSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync'], 'STORAGE');
guard(fs.promises, ['writeFile', 'appendFile', 'truncate', 'copyFile', 'cp', 'rename'], 'STORAGE');
syncBuiltinESMExports();
process.on('exit', () => { if (forbiddenExit) process.exitCode = forbiddenExit; });
