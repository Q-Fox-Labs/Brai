#!/usr/bin/env node
// ABOUTME: Собирает переносимый host-agent из явного immutable Git commit.
// ABOUTME: Устанавливает только locked production dependencies; не запускает сервис и не читает admin.
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
const args = process.argv.slice(2);
const preparedDependencies = args.includes('--prepared-dependencies');
const options = Object.fromEntries(args.filter((value) => value !== '--prepared-dependencies').reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.slice(2), all[index + 1]]], []));
const { source, revision, output } = options;
if (Object.keys(options).some(key => !['source', 'revision', 'output'].includes(key)) || !source || !output || !isAbsolute(source) || !isAbsolute(output) || !/^[0-9a-f]{40}$/.test(revision ?? '')) throw Error('EXPLICIT_BUILD_INPUTS_REQUIRED');
if (process.version !== 'v24.22.1') throw Error('NODE_VERSION_MISMATCH');
/** Запускает один инструмент с ограниченными временем и выводом. */
function run(file, args, cwd = source) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 }).trim();
}
async function inventoryFiles(directory, relativeTo = directory, files = []) {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('ARTIFACT_CONTAINS_SYMLINK');
    if (info.isDirectory()) await inventoryFiles(path, relativeTo, files);
    else if (info.isFile()) files.push({ path: path.slice(relativeTo.length + 1).split('\\').join('/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    else throw Error('ARTIFACT_CONTAINS_NONREGULAR_FILE');
  }
  return files;
}
async function payloadDigest(files) {
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
  return digest.digest('hex');
}
async function installedPackageClosure(root) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const [virtualLockPath, entry] of Object.entries(lock.packages)) {
    if (!virtualLockPath.startsWith('node_modules/') || entry.link) continue;
    const packagePath = join(root, virtualLockPath, 'package.json');
    let actual;
    try { actual = JSON.parse(await readFile(packagePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (actual.version !== entry.version) throw Error(`LOCKED_PACKAGE_VERSION_MISMATCH:${virtualLockPath}`);
    packages.push({ virtualLockPath, name: actual.name, version: actual.version, ...(entry.integrity ? { integrity: entry.integrity } : {}), ...(entry.resolved ? { resolved: entry.resolved } : {}) });
  }
  for (const workspacePath of ['services/agent', 'services/artifacts']) {
    const entry = lock.packages[workspacePath];
    const manifest = JSON.parse(await readFile(join(root, workspacePath, 'package.json'), 'utf8'));
    if (!entry || entry.version !== manifest.version) throw Error(`WORKSPACE_VERSION_MISMATCH:${workspacePath}`);
    packages.push({ virtualLockPath: workspacePath, name: manifest.name, version: manifest.version });
  }
  return packages.sort((a, b) => a.virtualLockPath.localeCompare(b.virtualLockPath));
}
async function writeArtifactManifest(output, fields) {
  const payloadFiles = await inventoryFiles(output);
  await writeFile(join(output, 'artifact-manifest.json'), `${JSON.stringify({ ...fields, runtimePackages: fields.runtimePackages, payloadFiles, payloadSha256: await payloadDigest(payloadFiles) }, null, 2)}\n`, { flag: 'wx' });
}
if (run('npm', ['--version']) !== '11.19.1') throw Error('NPM_VERSION_MISMATCH');
if (preparedDependencies) {
  run(process.execPath, [join(import.meta.dirname, 'materialize-runtime.mjs'), '--source', source, '--workspace', '@brai/agent', '--revision', revision, '--output', output]);
  const agent = JSON.parse(await readFile(join(source, 'services/agent/package.json'), 'utf8'));
  const runtime = JSON.parse(await readFile(join(output, 'runtime-manifest.json'), 'utf8'));
  await writeArtifactManifest(output, { format: 'brai-host-agent-artifact-v2', sourceRevision: revision, nodeVersion: '24.22.1', npmVersion: '11.19.1', agentPackage: { name: agent.name, version: agent.version }, productionDependencies: agent.dependencies, entrypoints: ['services/agent/dist/main.js', 'services/agent/dist/health.js'], runtimePackages: runtime.runtimePackages });
  console.log(JSON.stringify({ artifact: output, revision, preparedDependencies: true }));
  process.exit(0);
}
try { await stat(output); throw Error('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(join(tmpdir(), 'brai-agent-build-'));
try {
  run('git', ['archive', '--format=tar', `--output=${join(stage, 'source.tar')}`, revision]);
  run('tar', ['-xf', 'source.tar'], stage);
  run('npm', ['ci', '--workspace=@brai/agent'], stage);
  run('npm', ['run', 'build', '--workspace=@brai/agent'], stage);
  run('npm', ['ci', '--omit=dev', '--workspace=@brai/agent'], stage);
  const agent = JSON.parse(await readFile(join(stage, 'services/agent/package.json'), 'utf8'));
  for (const [path, entry] of Object.entries(JSON.parse(await readFile(join(stage, 'package-lock.json'), 'utf8')).packages)) if (entry.link && path.startsWith('node_modules/')) await rm(join(stage, path), { force: true });
  await mkdir(join(output, 'services/agent'), { recursive: true });
  for (const name of ['dist', 'contracts', 'package.json']) await cp(join(stage, 'services/agent', name), join(output, 'services/agent', name), { recursive: true, dereference: true });
  await mkdir(join(output, 'services/artifacts'), { recursive: true });
  for (const name of ['contracts', 'schemas']) await cp(join(stage, 'services/artifacts', name), join(output, 'services/artifacts', name), { recursive: true, dereference: true });
  await cp(join(stage, 'node_modules'), join(output, 'node_modules'), { recursive: true, dereference: true });
  const runtimePackages = await installedPackageClosure(stage);
  await writeArtifactManifest(output, { format: 'brai-host-agent-artifact-v2', sourceRevision: revision, nodeVersion: '24.22.1', npmVersion: '11.19.1', agentPackage: { name: agent.name, version: agent.version }, productionDependencies: agent.dependencies, entrypoints: ['services/agent/dist/main.js', 'services/agent/dist/health.js'], runtimePackages });
  console.log(JSON.stringify({ artifact: output, revision }));
} finally { await rm(stage, { recursive: true, force: true }); }
