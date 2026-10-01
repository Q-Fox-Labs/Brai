#!/usr/bin/env node
// ABOUTME: Собирает переносимый host-agent из явного immutable Git commit.
// ABOUTME: Устанавливает только locked production dependencies; не запускает сервис и не читает admin.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.slice(2), all[index + 1]]], []));
const { source, revision, output } = options;
if (Object.keys(options).some(key => !['source', 'revision', 'output'].includes(key)) || !source || !output || !isAbsolute(source) || !isAbsolute(output) || !/^[0-9a-f]{40}$/.test(revision ?? '')) throw Error('EXPLICIT_BUILD_INPUTS_REQUIRED');
if (process.version !== 'v24.21.0') throw Error('NODE_VERSION_MISMATCH');
/** Запускает один инструмент с ограниченными временем и выводом. */
function run(file, args, cwd = source) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 }).trim();
}
if (run('npm', ['--version']) !== '11.19.0') throw Error('NPM_VERSION_MISMATCH');
run('git', ['cat-file', '-e', `${revision}^{commit}`]);
try { await stat(output); throw Error('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(join(tmpdir(), 'brai-agent-build-'));
try {
  run('git', ['archive', '--format=tar', `--output=${join(stage, 'source.tar')}`, revision]);
  run('tar', ['-xf', 'source.tar'], stage);
  await rm(join(stage, 'source.tar'));
  run('npm', ['ci', '--workspace=@brai/agent'], stage);
  run('npm', ['run', 'build', '--workspace=@brai/agent'], stage);
  run('npm', ['ci', '--omit=dev', '--workspace=@brai/agent'], stage);
  const agent = JSON.parse(await readFile(join(stage, 'services/agent/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8'));
  for (const [path, entry] of Object.entries(lock.packages)) if (entry.link && path.startsWith('node_modules/')) await rm(join(stage, path), { force: true });
  await mkdir(join(output, 'services/agent'), { recursive: true });
  for (const name of ['dist', 'contracts', 'package.json']) await cp(join(stage, 'services/agent', name), join(output, 'services/agent', name), { recursive: true, dereference: true });
  await cp(join(stage, 'node_modules'), join(output, 'node_modules'), { recursive: true, dereference: true });
  const manifest = { format: 'brai-host-agent-artifact-v2', sourceRevision: revision, nodeVersion: '24.21.0', npmVersion: '11.19.0', agentPackage: { name: agent.name, version: agent.version }, productionDependencies: agent.dependencies, entrypoints: ['services/agent/dist/main.js', 'services/agent/dist/health.js'] };
  await writeFile(join(output, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ artifact: output, revision }));
} finally { await rm(stage, { recursive: true, force: true }); }
