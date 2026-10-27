// ABOUTME: Читает только безопасную конфигурацию общей файловой границы текущего экземпляра.
// ABOUTME: Private bootstrap получает owner и пути без NATS credentials или HTTP bearer.
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Возвращает root-owned файловую конфигурацию, привязанную к этому owner/runtime. */
export async function fileConfiguration(config, fail) {
  const path = join(dirname(config.publisher.configPath), 'files.json');
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 65536) throw fail('FILES_CONFIG_UNTRUSTED');
  const value = JSON.parse(await readFile(path, 'utf8'));
  const allowed = ['engineRoot', 'runtimeUser', 'ownerId', 'account', 'stateRoot', 'resultRoot', 'moduleRoot', 'toolsConfig', 'node', 'entry', 'readRoots', 'temporaryRoots', 'serviceRoots', 'legacyRoots'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.ownerId !== config.ownerId ||
      value.moduleRoot !== fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '')) throw fail('FILES_CONFIG_UNTRUSTED');
  return value;
}
