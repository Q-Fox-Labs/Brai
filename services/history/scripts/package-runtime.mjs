// ABOUTME: Собирает переносимый Docker-контекст истории из собранного сервиса и locked runtime deps.
// ABOUTME: Не устанавливает пакеты, не обращается к сети и пишет только в root tmp/.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const serviceKey = 'services/history';
const serviceDirectory = join(repositoryRoot, serviceKey);
const defaultOutput = 'tmp/history-runtime';
const requiredEntrypoints = ['dist/main.js', 'dist/migrate.js', 'dist/health.js'];
const packageEntryChecks = ['@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/streamableHttp.js', '@modelcontextprotocol/sdk/types.js', 'ajv', 'ajv-formats', 'nats', 'pg', 'zod'];
const manifestFormat = 'brai-history-runtime-v1';

function fail(code) {
  throw new Error(code);
}

function parseOutput(args) {
  if (args.length === 0) return defaultOutput;
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || isAbsolute(args[1])) fail('USAGE: node services/history/scripts/package-runtime.mjs [--output tmp/<name>]');
  return args[1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function lockCandidates(packageKey, dependencyName) {
  const candidates = [];
  let cursor = packageKey;
  while (cursor && cursor !== '.') {
    candidates.push(`${cursor}/node_modules/${dependencyName}`);
    const parent = dirname(cursor);
    cursor = parent === 'node_modules' || parent.endsWith('/node_modules') ? dirname(parent) : parent;
  }
  candidates.push(`node_modules/${dependencyName}`);
  return [...new Set(candidates)];
}

function modulePathFromLockKey(packageKey) {
  const marker = 'node_modules/';
  const index = packageKey.indexOf(marker);
  if (index < 0) fail(`LOCK_PACKAGE_OUTSIDE_NODE_MODULES: ${packageKey}`);
  return packageKey.slice(index);
}

function installedPackage(lockKey, entry, dependencyName) {
  if (entry.link) fail(`WORKSPACE_DEPENDENCY_NOT_PORTABLE: ${lockKey}`);
  const packageDirectory = resolve(repositoryRoot, lockKey);
  const rootPrefix = `${repositoryRoot}${sep}`;
  if (!packageDirectory.startsWith(rootPrefix)) fail(`INVALID_LOCK_PATH: ${lockKey}`);
  if (!existsSync(packageDirectory)) return null;
  const metadata = readJson(join(packageDirectory, 'package.json'));
  if (metadata.name !== (entry.name ?? dependencyName)) fail(`PACKAGE_NAME_MISMATCH: ${lockKey}`);
  if (metadata.version !== entry.version) fail(`PACKAGE_VERSION_MISMATCH: ${lockKey}`);
  return packageDirectory;
}

function resolveLockDependency(lock, consumerKey, dependencyName, optional) {
  for (const candidate of lockCandidates(consumerKey, dependencyName)) {
    const entry = lock.packages[candidate];
    if (!entry) continue;
    const directory = installedPackage(candidate, entry, dependencyName);
    if (directory) return { key: candidate, entry, directory };
    if (optional) return null;
    fail(`MISSING_INSTALLED_PACKAGE: ${candidate}`);
  }
  if (optional) return null;
  fail(`LOCK_ENTRY_MISSING: ${consumerKey} -> ${dependencyName}`);
}

function collectRuntimePackages(lock, serviceManifest) {
  const pending = Object.keys(serviceManifest.dependencies ?? {}).map(name => ({ from: serviceKey, name, optional: false }));
  for (const name of Object.keys(serviceManifest.optionalDependencies ?? {})) pending.push({ from: serviceKey, name, optional: true });
  for (const [name] of Object.entries(serviceManifest.peerDependencies ?? {})) pending.push({ from: serviceKey, name, optional: serviceManifest.peerDependenciesMeta?.[name]?.optional === true });
  const visited = new Map();
  while (pending.length) {
    const request = pending.pop();
    const resolved = resolveLockDependency(lock, request.from, request.name, request.optional);
    if (!resolved || visited.has(resolved.key)) continue;
    visited.set(resolved.key, resolved);
    const { entry, key } = resolved;
    for (const name of Object.keys(entry.dependencies ?? {})) pending.push({ from: key, name, optional: false });
    for (const name of Object.keys(entry.optionalDependencies ?? {})) pending.push({ from: key, name, optional: true });
    for (const [name] of Object.entries(entry.peerDependencies ?? {})) {
      const optional = entry.peerDependenciesMeta?.[name]?.optional === true;
      pending.push({ from: key, name, optional });
    }
  }
  return visited;
}

async function validateInstalledRuntime(artifactDirectory) {
  const smokePath = join(artifactDirectory, '.runtime-dependency-smoke.mjs');
  writeFileSync(smokePath, `await Promise.all(${JSON.stringify(packageEntryChecks)}.map(name => import(name)));\n`);
  try {
    // AIDEV-NOTE: The temporary module resolves as ESM from the artifact itself; it loads libraries only and never starts service generation.
    await import(pathToFileURL(smokePath).href);
  } catch {
    fail('ARTIFACT_IMPORT_FAILED');
  } finally {
    rmSync(smokePath, { force: true });
  }
}
async function copyRuntime(artifactDirectory, packages, serviceManifest) {
  for (const relativePath of ['dist', 'schemas', 'migrations']) {
    const source = join(serviceDirectory, relativePath);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) fail(`MISSING_RUNTIME_DIRECTORY: ${relativePath}`);
    cpSync(source, join(artifactDirectory, relativePath), { recursive: true, dereference: true, preserveTimestamps: true });
  }
  for (const entrypoint of requiredEntrypoints) {
    if (!existsSync(join(artifactDirectory, entrypoint))) fail(`MISSING_RUNTIME_ENTRYPOINT: ${entrypoint}`);
  }
  for (const name of ['CONTRACT.md', 'README.md']) cpSync(join(serviceDirectory, name), join(artifactDirectory, name));
  writeFileSync(join(artifactDirectory, 'package.json'), `${JSON.stringify({ name: serviceManifest.name, version: serviceManifest.version, private: true, type: serviceManifest.type, engines: serviceManifest.engines, dependencies: serviceManifest.dependencies }, null, 2)}\n`);
  cpSync(join(serviceDirectory, 'Dockerfile'), join(artifactDirectory, 'Dockerfile'));
  for (const { key, directory } of packages.values()) {
    const target = join(artifactDirectory, modulePathFromLockKey(key));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(directory, target, { recursive: true, dereference: true, preserveTimestamps: true, filter: source => basename(source) !== 'node_modules' });
  }
  const manifestPath = join(artifactDirectory, 'artifact-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({ format: manifestFormat, package: serviceManifest.name, version: serviceManifest.version, runtimePackages: [...packages.keys()].sort() }, null, 2)}\n`);
  if (!readFileSync(manifestPath, 'utf8').endsWith('\n') || readJson(manifestPath).format !== manifestFormat) fail('INVALID_ARTIFACT_MANIFEST');
  await validateInstalledRuntime(artifactDirectory);
}

function prepareOutput(outputRelative) {
  const output = resolve(repositoryRoot, outputRelative);
  const tempRoot = resolve(repositoryRoot, 'tmp');
  if (dirname(output) !== tempRoot) fail('OUTPUT_MUST_BE_DIRECT_CHILD_OF_ROOT_TMP');
  mkdirSync(tempRoot, { recursive: true });
  if (existsSync(output)) {
    if (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) fail('OUTPUT_NOT_OWNED');
    const existingManifest = join(output, 'artifact-manifest.json');
    if (!existsSync(existingManifest) || readJson(existingManifest).format !== manifestFormat) fail('OUTPUT_NOT_OWNED');
  }
  const stage = mkdtempSync(join(tempRoot, '.history-runtime-stage-'));
  return { output, stage };
}

async function main() {
  const outputRelative = parseOutput(process.argv.slice(2));
  const packageFile = join(serviceDirectory, 'package.json');
  const packageLockFile = join(repositoryRoot, 'package-lock.json');
  if (!existsSync(packageFile) || !existsSync(packageLockFile)) fail('PACKAGE_MANIFEST_OR_LOCK_MISSING');
  const serviceManifest = readJson(packageFile);
  const lock = readJson(packageLockFile);
  const lockedService = lock.packages?.[serviceKey];
  if (!lockedService) fail(`LOCK_SERVICE_ENTRY_MISSING: ${serviceKey}`);
  const sorted = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  if (sorted(lockedService.dependencies) !== sorted(serviceManifest.dependencies)) fail('SERVICE_LOCK_DEPENDENCIES_MISMATCH');
  const packages = collectRuntimePackages(lock, serviceManifest);
  const { output, stage } = prepareOutput(outputRelative);
  try {
    await copyRuntime(stage, packages, serviceManifest);
    if (existsSync(output)) rmSync(output, { recursive: true });
    renameSync(stage, output);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(`Prepared ${serviceManifest.name}@${serviceManifest.version}: ${packages.size} locked runtime packages -> ${relative(repositoryRoot, output)}`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
