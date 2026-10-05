// ABOUTME: Запускает настоящий startCoordinator в отдельной принадлежащей тесту группе процессов.
// ABOUTME: IPC возвращает только readiness/address; конфигурация и ошибки не пишутся в stdout/stderr.
import { startCoordinator } from '../../../dist/coordinator/main.js';

let runtime;
let started = false;
let closing;
async function close() {
  if (!closing) closing = runtime ? runtime.close() : Promise.resolve();
  await closing;
}
process.on('message', (message) => {
  void (async () => {
    const reply = (value) => { if (process.connected) process.send({ id: message.id, ...value }); };
    if (message.action === 'start' && !started) {
      started = true;
      try { runtime = await startCoordinator(message.config); reply({ okay: true, address: runtime.address() }); }
      catch { reply({ okay: false }); }
    } else if (message.action === 'status' && runtime) {
      try { reply({ okay: true, status: await runtime.status() }); } catch { reply({ okay: false }); }
    } else if (message.action === 'close') {
      await close(); reply({ okay: true }); process.disconnect();
    } else reply({ okay: false });
  })().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
});
process.once('disconnect', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void close().finally(() => { if (process.connected) process.disconnect(); });
});
