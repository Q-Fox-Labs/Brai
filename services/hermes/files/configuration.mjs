// ABOUTME: Читает только безопасную конфигурацию общей файловой границы текущего экземпляра.
// ABOUTME: Private bootstrap получает owner и пути без NATS credentials или HTTP bearer.
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '');

/** Читает только защищённые настройки владельца, без исполнения сохранённых программных путей. */
async function readConfiguration(config, fail, ports) {
  const path = join(dirname(config.publisher.configPath), 'files.json');
  const info = await ports.lstat(path);
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 65536) throw fail('FILES_CONFIG_UNTRUSTED');
  const value = JSON.parse(await ports.readFile(path, 'utf8'));
  const allowed = ['engineRoot', 'runtimeUser', 'ownerId', 'account', 'stateRoot', 'resultRoot', 'moduleRoot', 'toolsConfig', 'node', 'entry', 'readRoots', 'temporaryRoots', 'serviceRoots', 'legacyRoots'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.ownerId !== config.ownerId) throw fail('FILES_CONFIG_UNTRUSTED');
  return value;
}

/** Возвращает fixed-owner конфигурацию только для её точной версии runtime. */
export async function fileConfiguration(config, fail, ports = { lstat, readFile }) {
  const value = await readConfiguration(config, fail, ports);
  if (value.moduleRoot !== moduleRoot) throw fail('FILES_CONFIG_UNTRUSTED');
  return value;
}

/** Личный Control связывает программы со своей принятой версией, сохраняя настройки данных владельца. */
export async function identityFileConfiguration(config, fail, ports = { lstat, readFile }) {
  const value = await readConfiguration(config, fail, ports);
  // AIDEV-NOTE: Старые root-only профили переживают общий выпуск и откат без перезаписи.
  // Эти два поля не используются для открытия или исполнения прежнего кода.
  return { ...value, moduleRoot, entry: join(dirname(moduleRoot), 'tools.mjs') };
}
