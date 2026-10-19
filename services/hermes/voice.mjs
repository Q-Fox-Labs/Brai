// ABOUTME: Подключает нативный tts Hermes к опубликованному синтезу Local AI.
// ABOUTME: Передаёт файлы через Artifacts/publisher; собственную модель или runner не запускает.
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, open, constants } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { startBraiTools, fault } from './runtime.mjs';

/** Синтезирует один UTF-8 файл выбранным профилем и копирует проверенный OGG без перезаписи. */
export async function synthesizeFile(config, runtime, { input, output, voice }) {
  if (!isAbsolute(input ?? '') || !isAbsolute(output ?? '') || voice !== 'eugene' || !config.tts?.model) throw fault('INVALID_ARGUMENT');
  try { await lstat(output); throw fault('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = Buffer.alloc(3601), handle = await open(input, 'r');
  let size = 0;
  try {
    if (!(await handle.stat()).isFile()) throw fault('INVALID_ARGUMENT');
    while (size < source.length) {
      const { bytesRead } = await handle.read(source, size, source.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } finally { await handle.close(); }
  if (size > 3600) throw fault('INPUT_TOO_LARGE');
  let text; try { text = new TextDecoder('utf8', { fatal: true }).decode(source.subarray(0, size)); } catch { throw fault('INVALID_ARGUMENT'); }
  const result = await runtime.call('local_ai_invoke_synthesize', { requestId: randomUUID(), operationId: randomUUID(),
    model: config.tts.model, deadlineAt: new Date(Date.now() + 180_000).toISOString(), text, voice });
  const file = await runtime.call('fetch_file', { artifactId: result.audioArtifactId });
  if (file.mimeType !== 'audio/ogg' || !isAbsolute(file.localPath)) throw fault('INVALID_UPSTREAM_RESPONSE');
  await copyFile(file.localPath, output, constants.COPYFILE_EXCL);
  return { artifactId: result.audioArtifactId, output };
}

// Стабильная ссылка выпуска и import.meta.url должны указывать на один файл.
let isMain = false;
try { isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch {}
if (isMain) {
  let runtime;
  try {
    const args = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index];
      if (!['--input', '--output', '--voice'].includes(key) || args[key.slice(2)] || !process.argv[index + 1]) throw fault('INVALID_ARGUMENT');
      args[key.slice(2)] = process.argv[index + 1];
    }
    const config = await loadConfig(); runtime = await startBraiTools(config);
    await synthesizeFile(config, runtime, args);
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'HERMES_VOICE_FAILED'); process.exitCode = 1;
  } finally { await runtime?.close(); }
}
