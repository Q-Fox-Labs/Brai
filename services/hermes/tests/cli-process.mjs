// ABOUTME: Запускает дочерний процесс теста с ожиданием закрытия и штатной отменой.
// ABOUTME: Сохраняет проверку результата процесса без ограничения времени запуска.
import { spawn } from 'node:child_process';

// spawnSync использовал стандартный maxBuffer Node; сохраняем тот же предел вывода.
const maxBuffer = 1024 * 1024;

export function startProcess(command, args, { env, signal } = {}) {
  let child;
  const result = new Promise(resolve => {
    let failure;
    const stdout = [], stderr = [], sizes = { stdout: 0, stderr: 0 };
    const collect = (name, chunks) => chunk => {
      sizes[name] += chunk.length;
      if (sizes[name] > maxBuffer) {
        failure ??= Object.assign(new RangeError(`${name} maxBuffer exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    };
    child = spawn(command, args, { env, signal, killSignal: 'SIGKILL' });
    child.stdout.on('data', collect('stdout', stdout));
    child.stderr.on('data', collect('stderr', stderr));
    child.on('error', error => { failure ??= error; });
    child.once('close', (status, exitSignal) => {
      resolve({ error: failure, status, signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  return { child, result };
}

export function startNode(args, options) {
  return startProcess(process.execPath, args, options);
}
