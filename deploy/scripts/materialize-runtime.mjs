#!/usr/bin/env node
// ABOUTME: Копирует готовое production runtime из проверенного workspace и lockfile.
// ABOUTME: Не устанавливает зависимости и не собирает исходники.
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.slice(2), all[index + 1]]], []));
const { source, workspace, revision, output } = options;
if (Object.keys(options).some((key) => !['source', 'workspace', 'revision', 'output'].includes(key)) || !source || !workspace || !output || !isAbsolute(source) || !isAbsolute(output) || !/^[0-9a-f]{40}$/.test(revision ?? '')) throw Error('EXPLICIT_BUILD_INPUTS_REQUIRED');
if (!['@brai/artifacts', '@brai/agent', '@brai/web', '@brai/timer'].includes(workspace)) throw Error('UNSUPPORTED_RUNTIME_WORKSPACE');
if (process.version !== 'v24.21.0') throw Error('NODE_VERSION_MISMATCH');
const run = (file, args) => execFileSync(file, args, { cwd: source, encoding: 'utf8', timeout: 30000 }).trim();
const actualRevision = run('git', ['rev-parse', 'HEAD']);
if (actualRevision !== revision) throw Error('SOURCE_REVISION_MISMATCH');
if (run('git', ['status', '--porcelain']).length) throw Error('SOURCE_TREE_DIRTY');
const root = await realpath(source);
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (lock.lockfileVersion !== 3) throw Error('LOCKFILE_VERSION_MISMATCH');
try { await stat(output); throw Error('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const workspaces = new Map();
for (const [lockPath, entry] of Object.entries(lock.packages)) {
  if (!lockPath || lockPath.startsWith('node_modules/') || !entry.name?.startsWith('@brai/')) continue;
  workspaces.set(entry.name, { lockPath, entry });
}
// AIDEV-NOTE: npm размещает несовместимые версии внутри workspace; их virtual lock paths сохраняются в bundle.
const moduleRoots = ['node_modules/', ...[...workspaces.values()].map(({ lockPath }) => `${lockPath}/node_modules/`)];
const requested = [...workspaces].find(([, value]) => value.lockPath === (workspace === '@brai/web' ? 'apps/web' : `services/${workspace.slice('@brai/'.length)}`));
if (!requested) throw Error('WORKSPACE_NOT_IN_LOCKFILE');
const [packageName, { lockPath: workspacePath, entry: workspaceEntry }] = requested;
const copied = new Set();
const runtimePackages = new Map();

async function findInstalled(name, from) {
  let current = from;
  while (current.startsWith(root)) {
    if (current === join(root, 'node_modules') || current.endsWith(`${sep}node_modules`)) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    const candidate = join(current, 'node_modules', ...name.split('/'));
    try { await stat(join(candidate, 'package.json')); return candidate; } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw Error(`RUNTIME_DEPENDENCY_MISSING:${name}`);
}

async function copyWorkspace(name, from) {
  const workspaceInfo = workspaces.get(name);
  if (!workspaceInfo) return false;
  const { lockPath: path, entry } = workspaceInfo;
  const sourcePath = join(root, path);
  const packageInfo = JSON.parse(await readFile(join(sourcePath, 'package.json'), 'utf8'));
  if (packageInfo.version !== entry.version) throw Error(`WORKSPACE_VERSION_MISMATCH:${name}`);
  runtimePackages.set(path, { virtualLockPath: path, name, version: entry.version });
  const targetDir = join(output, 'node_modules', ...name.split('/'));
  if (!copied.has(path)) {
    copied.add(path);
    await mkdir(targetDir, { recursive: true });
    const selected = name === '@brai/agent' ? ['package.json', 'dist', 'contracts'] : ['package.json', 'dist', 'contracts', 'schemas', 'migrations'];
    for (const item of selected) await cp(join(sourcePath, item), join(targetDir, item), { recursive: true, dereference: true });
    if (name === '@brai/agent') { await copyArtifactSiblings(); await copyArtifactPackage(); }
  }
  await visitDependencies(path, entry, sourcePath);
  return true;
}

async function copyArtifactSiblings() {
  await mkdir(join(output, 'services/artifacts'), { recursive: true });
  const artifacts = join(root, 'services/artifacts');
  for (const item of ['contracts', 'schemas']) await cp(join(artifacts, item), join(output, 'services/artifacts', item), { recursive: true, dereference: true, force: true });
}

async function copyArtifactPackage() {
  const artifacts = join(root, 'services/artifacts');
  const destination = join(output, 'node_modules/@brai/artifacts');
  await mkdir(destination, { recursive: true });
  for (const item of ['package.json', 'contracts', 'schemas']) await cp(join(artifacts, item), join(destination, item), { recursive: true, dereference: true, force: true });
}

async function visitDependencies(path, entry, packageDir) {
  if (copied.has(`visited:${path}`)) return;
  copied.add(`visited:${path}`);
  const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
  for (const [name, expected] of Object.entries(dependencies)) {
    const installed = await findInstalled(name, packageDir).catch((error) => {
      if (entry.optionalDependencies?.[name] || entry.peerDependenciesMeta?.[name]?.optional) return undefined;
      throw error;
    });
    if (!installed) continue;
    const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    const rel = relative(root, installed).split(sep).join('/');
    const virtualEntry = lock.packages[rel];
    if (workspaces.has(name)) {
      if (!virtualEntry?.link || !satisfiesWorkspace(installedPackage.version, expected)) throw Error(`RUNTIME_DEPENDENCY_VERSION_MISMATCH:${name}`);
      await copyWorkspace(name, installed);
      continue;
    }
    if (!moduleRoots.some(prefix => rel.startsWith(prefix))) throw Error(`UNSUPPORTED_RUNTIME_PACKAGE_PATH:${name}`);
    const packageEntry = virtualEntry;
    if (!packageEntry || packageEntry.link || packageEntry.version !== installedPackage.version) throw Error(`LOCKED_PACKAGE_VERSION_MISMATCH:${name}`);
    runtimePackages.set(rel, { virtualLockPath: rel, name: installedPackage.name ?? name, version: installedPackage.version, ...(packageEntry.integrity ? { integrity: packageEntry.integrity } : {}), ...(packageEntry.resolved ? { resolved: packageEntry.resolved } : {}) });
    if (!copied.has(rel)) {
      copied.add(rel);
      await cp(installed, join(output, rel), { recursive: true, dereference: true });
    }
    await visitDependencies(rel, packageEntry, installed);
  }
}

function satisfiesWorkspace(version, range) {
  return [version, `^${version}`, `~${version}`, `workspace:${version}`, `workspace:^${version}`, `workspace:~${version}`].includes(range);
}

const sourcePackage = join(root, workspacePath);
const sourceManifest = JSON.parse(await readFile(join(sourcePackage, 'package.json'), 'utf8'));
if (sourceManifest.version !== workspaceEntry.version) throw Error('WORKSPACE_VERSION_MISMATCH');
runtimePackages.set(workspacePath, { virtualLockPath: workspacePath, name: packageName, version: workspaceEntry.version });
const sourceFiles = workspace === '@brai/web' ? ['package.json', '.next', 'public'] : workspace === '@brai/agent' ? ['package.json', 'dist', 'contracts'] : workspace === '@brai/artifacts' ? ['package.json', 'dist', 'contracts', 'schemas', 'migrations'] : workspace === '@brai/timer' ? ['package.json', 'dist', 'schemas', 'migrations'] : ['package.json'];
const destination = join(output, workspacePath);
await mkdir(destination, { recursive: true });
for (const item of sourceFiles) {
  const sourcePath = join(sourcePackage, item);
  const copyOptions = item === '.next' ? { recursive: true, dereference: true, filter: (path) => !path.startsWith(`${sourcePath}${sep}cache${sep}`) && path !== join(sourcePath, 'cache') && path !== join(sourcePath, 'trace') } : { recursive: true, dereference: true };
  await cp(sourcePath, join(destination, item), copyOptions);
}
if (workspace === '@brai/agent' || workspace === '@brai/web') await copyArtifactSiblings();
const dockerfile = workspace === '@brai/artifacts' ? 'services/artifacts/Dockerfile.prepared' : workspace === '@brai/web' ? 'apps/web/Dockerfile.prepared' : `services/${workspace.slice('@brai/'.length)}/Dockerfile.prepared`;
if (workspace !== '@brai/agent') await cp(join(root, dockerfile), join(output, 'Dockerfile'));
await visitDependencies(workspacePath, workspaceEntry, sourcePackage);
await mkdir(output, { recursive: true });
if (workspace === '@brai/web') {
  // AIDEV-NOTE: Схемы alerts принадлежат сервису и должны оставаться доступны веб-шлюзу после упаковки.
  await mkdir(join(output, 'services/alerts'), { recursive: true });
  for (const item of ['contracts', 'schemas']) await cp(join(root, 'services/alerts', item), join(output, 'services/alerts', item), { recursive: true, dereference: true });
  await mkdir(join(output, 'services/agent'), { recursive: true });
  const agent = join(root, 'services/agent');
  for (const item of ['package.json', 'dist', 'contracts']) await cp(join(agent, item), join(output, 'services/agent', item), { recursive: true, dereference: true });
}
await mkdir(join(output, 'services/artifacts'), { recursive: true });
if (workspace === '@brai/web' || workspace === '@brai/agent') await copyArtifactSiblings();
async function collectPayload(path, rootPath = path, files = []) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error('RUNTIME_CONTAINS_SYMLINK');
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await collectPayload(join(path, name), rootPath, files);
    return files;
  }
  if (!info.isFile()) throw Error('RUNTIME_CONTAINS_NONREGULAR_FILE');
  const relativePath = relative(rootPath, path).split(sep).join('/');
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  files.push({ path: relativePath, sha256 });
  return files;
}
const payloadFiles = await collectPayload(output);
const payloadHash = createHash('sha256');
for (const file of payloadFiles) payloadHash.update(`${file.path}\0${file.sha256}\n`);
const manifest = {
  format: 'brai-prepared-runtime-v1',
  sourceRevision: revision,
  nodeVersion: '24.21.0',
  workspace: packageName,
  packageVersion: sourceManifest.version,
  productionDependencies: sourceManifest.dependencies ?? {},
  runtimePackages: [...runtimePackages.values()].sort((a, b) => a.virtualLockPath.localeCompare(b.virtualLockPath)),
  payloadFiles,
  payloadSha256: payloadHash.digest('hex'),
};
await writeFile(join(output, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ runtime: output, revision, workspace: packageName }));
