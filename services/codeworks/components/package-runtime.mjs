// ABOUTME: Собирает неизменяемую поставку компонента из явных файлов и установленного npm lock closure.
// ABOUTME: Не устанавливает зависимости, не собирает исходники и не включает внешние runtime или данные.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const format = 'brai-component-runtime-v1';
const manifestName = 'artifact-manifest.json';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
const fail = message => { throw new Error(message); };
const present = path => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
let detectedLibc;

function repositoryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || isAbsolute(value) || value === '.' || value !== posix.normalize(value) || value.startsWith('../')) fail(`INVALID_REPOSITORY_PATH: ${value}`);
  return value;
}

function checkFirstPartyPath(key) {
  const parts = key.split('/');
  if (parts.some(part => /^(?:\.env(?:\..*)?|\.git|node_modules|tests?|__tests__|data|datasets|weights)$/i.test(part)) || /(?:^|[/_.-])credentials?(?:[./_-]|$)/i.test(key) || /\.(?:key|pem|p12|pfx|gguf|safetensors|pt|pth|bin)$/i.test(key) || /\.(?:test|spec)\.[^/]+$/i.test(key)) fail(`FORBIDDEN_DELIVERY_FILE: ${key}`);
  if (/\.(?:[cm]?tsx?|jsx)$/i.test(key) && !/\.d\.(?:ts|mts|cts)$/i.test(key)) fail(`UNBUILT_DELIVERY_SOURCE: ${key}`);
}

function copyDelivery(root, stage, key) {
  repositoryPath(key);
  if (key === manifestName) fail('RESERVED_DELIVERY_FILE');
  checkFirstPartyPath(key);
  const source = join(root, key);
  if (!existsSync(source)) fail(`MISSING_DELIVERY_FILE: ${key}`);
  if (!inside(root, realpathSync(source))) fail(`DELIVERY_SYMLINK_ESCAPE: ${key}`);
  const info = lstatSync(source);
  if (info.isSymbolicLink()) fail(`DELIVERY_SYMLINK: ${key}`);
  if (info.isDirectory()) {
    for (const name of readdirSync(source).sort(compare)) copyDelivery(root, stage, `${key}/${name}`);
  } else if (info.isFile()) {
    const destination = join(stage, key);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    chmodSync(destination, info.mode & 0o777);
  } else fail(`UNSUPPORTED_DELIVERY_FILE: ${key}`);
}

function dependencyRequests(from, entry) {
  const optional = entry.optionalDependencies ?? {};
  const requests = Object.keys(entry.dependencies ?? {}).filter(name => !(name in optional)).map(name => ({ from, name, optional: false }));
  requests.push(...Object.keys(optional).map(name => ({ from, name, optional: true })));
  // Optional peers are consumer opt-ins, not dependencies of this package.
  // If used, the consuming workspace declares them directly (e.g. web -> next/react).
  requests.push(...Object.keys(entry.peerDependencies ?? {}).filter(name => entry.peerDependenciesMeta?.[name]?.optional !== true).map(name => ({ from, name, optional: false })));
  return requests;
}

function lockCandidates(from, name) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(name) || name.includes('..') || name.includes('\\')) fail(`INVALID_DEPENDENCY_NAME: ${name}`);
  const candidates = [];
  let cursor = from;
  while (cursor && cursor !== '.') {
    if (basename(cursor) !== 'node_modules') candidates.push(`${cursor}/node_modules/${name}`);
    cursor = posix.dirname(cursor);
  }
  candidates.push(`node_modules/${name}`);
  return [...new Set(candidates)];
}

function verifyWorkspace(root, lock, key) {
  repositoryPath(key);
  const directory = join(root, key);
  if (!inside(root, realpathSync(directory))) fail(`WORKSPACE_OUTSIDE_REPOSITORY: ${key}`);
  const manifest = json(join(directory, 'package.json'));
  const entry = lock.packages?.[key];
  if (!entry || entry.link) fail(`LOCK_WORKSPACE_ENTRY_MISSING: ${key}`);
  const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => compare(a, b))));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    if (canonical(manifest[field]) !== canonical(entry[field])) fail(`WORKSPACE_LOCK_MISMATCH: ${key}: ${field}`);
  }
  if (manifest.version !== entry.version || (entry.name && manifest.name !== entry.name)) fail(`WORKSPACE_LOCK_MISMATCH: ${key}: identity`);
  return manifest;
}

function supportsPlatform(entry) {
  const matches = (values, actual) => !values || (!values.includes(`!${actual}`) && (values.every(value => value.startsWith('!')) || values.includes(actual) || values.includes('any')));
  if (!matches(entry.os, process.platform) || !matches(entry.cpu, process.arch)) return false;
  if (!entry.libc || process.platform !== 'linux') return true;
  detectedLibc ??= process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  return matches(entry.libc, detectedLibc);
}

function collectPackages(root, workspaces) {
  if (!workspaces.length) return new Map();
  const lock = json(join(root, 'package-lock.json'));
  if (!lock.packages || lock.lockfileVersion < 2) fail('UNSUPPORTED_PACKAGE_LOCK');
  const pending = [];
  const visitedWorkspaces = new Set();
  const packages = new Map();
  const addWorkspace = key => {
    if (visitedWorkspaces.has(key)) return;
    const manifest = verifyWorkspace(root, lock, key);
    visitedWorkspaces.add(key);
    pending.push(...dependencyRequests(key, manifest));
  };
  workspaces.forEach(addWorkspace);
  while (pending.length) {
    const request = pending.pop();
    const key = lockCandidates(request.from, request.name).find(candidate => lock.packages[candidate]);
    if (!key) {
      if (request.optional) continue;
      fail(`LOCK_ENTRY_MISSING: ${request.from} -> ${request.name}`);
    }
    if (packages.has(key)) continue;
    repositoryPath(key);
    const entry = lock.packages[key];
    if (!supportsPlatform(entry)) {
      if (request.optional) continue;
      fail(`UNSUPPORTED_PACKAGE_PLATFORM: ${key}`);
    }
    const installed = join(root, key);
    if (!existsSync(installed)) {
      if (request.optional) continue;
      fail(`MISSING_INSTALLED_PACKAGE: ${key}`);
    }
    if (entry.link) {
      const target = repositoryPath(entry.resolved);
      if (!inside(root, realpathSync(installed)) || realpathSync(installed) !== realpathSync(join(root, target))) fail(`WORKSPACE_LINK_MISMATCH: ${key}`);
      addWorkspace(target);
      const metadata = json(join(root, target, 'package.json'));
      if (metadata.name !== request.name) fail(`PACKAGE_NAME_MISMATCH: ${key}`);
      packages.set(key, { key, entry, target, version: metadata.version });
    } else {
      // AIDEV-NOTE: Подготовленный worktree использует внешние symlink пакетов; lockKey всё равно задаёт место в поставке.
      const metadata = json(join(installed, 'package.json'));
      if (metadata.name !== (entry.name ?? request.name)) fail(`PACKAGE_NAME_MISMATCH: ${key}`);
      if (metadata.version !== entry.version) fail(`PACKAGE_VERSION_MISMATCH: ${key}`);
      packages.set(key, { key, entry, installed, version: entry.version });
      pending.push(...dependencyRequests(key, entry));
    }
  }
  return packages;
}

function copyPackages(root, stage, packages) {
  for (const { key, entry, installed, target } of [...packages.values()].sort((a, b) => compare(a.key, b.key))) {
    const destination = join(stage, key);
    mkdirSync(dirname(destination), { recursive: true });
    if (entry.link) {
      if (!existsSync(join(stage, target, 'package.json'))) fail(`WORKSPACE_RUNTIME_NOT_SELECTED: ${target}/package.json`);
      symlinkSync(relative(dirname(destination), join(stage, target)), destination);
    } else {
      cpSync(installed, destination, { recursive: true, dereference: true, filter: source => basename(source) !== 'node_modules' });
    }
  }
}

function inventory(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(join(directory, prefix)).sort(compare)) {
    const key = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === manifestName) continue;
    const path = join(directory, key);
    const info = lstatSync(path);
    if (info.isDirectory()) files.push(...inventory(directory, key));
    else if (info.isFile() || info.isSymbolicLink()) {
      const content = info.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
      files.push({ path: key, sha256: hash(content), size: content.length, mode: info.mode & 0o777, ...(info.isSymbolicLink() ? { symlink: content.toString() } : {}) });
    } else fail(`UNSUPPORTED_PAYLOAD_FILE: ${key}`);
  }
  return files.sort((a, b) => compare(a.path, b.path));
}

function payloadHash(files, runtime, runtimePackages) {
  return hash(JSON.stringify({files,runtime,runtimePackages}));
}

async function validateRuntime(stage, component) {
  for (const key of [...component.delivery.entrypoints, ...component.delivery.smokeImports]) {
    repositoryPath(key);
    if (!existsSync(join(stage, key)) || !lstatSync(join(stage, key)).isFile()) fail(`MISSING_RUNTIME_ENTRYPOINT: ${key}`);
  }
  // AIDEV-NOTE: Внутри root/tmp Node мог бы найти исходные node_modules выше поставки и скрыть недостающую зависимость.
  const isolated = mkdtempSync(join(tmpdir(), 'brai-component-smoke-'));
  try {
    cpSync(stage, isolated, { recursive: true, dereference: false });
    const env = { PATH: process.env.PATH ?? '', NODE_PATH: '', NODE_OPTIONS: '' };
    const options = { cwd: isolated, env, timeout: 30_000, maxBuffer: 1024 * 1024 };
    for (const key of component.delivery.entrypoints.filter(key => /\.(?:mjs|cjs|js)$/.test(key))) {
      await run(process.execPath, ['--check', join(isolated, key)], options);
    }
    if (component.delivery.smokeImports.length) {
      const script = component.delivery.smokeImports.map(key => `await import(${JSON.stringify(pathToFileURL(join(isolated, key)).href)}${key.endsWith('.json') ? ", { with: { type: 'json' } }" : ''});`).join('\n');
      await run(process.execPath, ['--input-type=module', '--eval', script], options);
    }
  } catch (error) {
    fail(`ARTIFACT_SMOKE_FAILED: ${error.stderr?.trim() || error.message}`);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

function prepareOutput(root, outputRoot) {
  const output = resolve(root, outputRoot);
  const temporary = join(root, 'tmp');
  if (!inside(temporary, output)) fail('OUTPUT_MUST_BE_UNDER_ROOT_TMP');
  let cursor = root;
  for (const segment of relative(root, output).split(sep)) {
    cursor = join(cursor, segment);
    if (present(cursor) && (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory())) fail('OUTPUT_NOT_OWNED');
  }
  mkdirSync(output, { recursive: true });
  return output;
}

/**
 * Собрать готовую поставку по описанию компонента без установки и сборки.
 * Пути delivery и npm.workspaces относительны root; outputRoot находится в root/tmp.
 * Для OCI delivery.command заменяет стандартный CMD node <первый entrypoint> без shell.
 * Возвращает manifest с абсолютным path. При неполной поставке или конфликте lock бросает ошибку.
 * Повторный вызов возвращает существующую поставку лишь после проверки её файлов и manifest.
 */
export async function packageComponent(root, component, outputRoot) {
  root = realpathSync(root);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(component.id)) fail('INVALID_COMPONENT_ID');
  repositoryPath(component.directory);
  if (!['ready-files', 'oci-context'].includes(component.delivery?.kind)) fail('INVALID_DELIVERY_KIND');
  const output = prepareOutput(root, outputRoot);
  const stage = mkdtempSync(join(output, '.component-stage-'));
  try {
    for (const key of [...new Set(component.delivery.files)]) copyDelivery(root, stage, key);
    const packages = collectPackages(root, component.npm?.workspaces ?? []);
    copyPackages(root, stage, packages);
    if (component.delivery.kind === 'oci-context') {
      const entrypoint = component.delivery.entrypoints[0];
      if (!entrypoint) fail('OCI_ENTRYPOINT_REQUIRED');
      if (existsSync(join(stage, 'Dockerfile'))) fail('DOCKERFILE_ALREADY_SELECTED');
      const command = component.delivery.command ?? ['node', posix.relative(component.directory, repositoryPath(entrypoint))];
      if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || !value || value.includes('\0'))) fail('INVALID_DELIVERY_COMMAND');
      writeFileSync(join(stage, 'Dockerfile'), `FROM node:24.21.0-bookworm-slim\nWORKDIR ${JSON.stringify(`/app/${component.directory}`)}\nCOPY . /app\nCMD ${JSON.stringify(command)}\n`);
      chmodSync(join(stage, 'Dockerfile'), 0o644);
    }
    await validateRuntime(stage, component);
    const files = inventory(stage);
    const runtimePackages = [...packages.values()].map(({ key, entry, version, target }) => ({ lockKey: key, version, ...(entry.integrity ? { integrity: entry.integrity } : {}), ...(target ? { link: true, target } : {}) })).sort((a, b) => compare(a.lockKey, b.lockKey));
    const runtime={kind:component.delivery.kind,workingDirectory:component.directory,entrypoints:component.delivery.entrypoints,command:component.delivery.command ?? (component.delivery.entrypoints.length?['node',posix.relative(component.directory,component.delivery.entrypoints[0])]:[]),systemRequirements:component.delivery.systemRequirements ?? []};
    const manifest = { format, componentId: component.id, payloadHash: payloadHash(files,runtime,runtimePackages), files, bytes: files.reduce((sum, file) => sum + file.size, 0), runtimePackages, runtime, systemRequirements: runtime.systemRequirements };
    const path = join(output, `${component.id}-${manifest.payloadHash}`);
    const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(stage, manifestName), encoded);
    chmodSync(join(stage, manifestName), 0o644);
    if (present(path)) {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || !lstatSync(join(path, manifestName), { throwIfNoEntry: false })?.isFile() || readFileSync(join(path, manifestName), 'utf8') !== encoded || JSON.stringify(inventory(path)) !== JSON.stringify(files)) fail(`IMMUTABLE_OUTPUT_MISMATCH: ${path}`);
      rmSync(stage, { recursive: true });
    } else renameSync(stage, path);
    return { ...manifest, path };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

// A cached artifact is reused only after checking every delivered byte and mode.
export function verifyPackage(path, componentId) {
  if (lstatSync(path).isSymbolicLink()) fail(`IMMUTABLE_OUTPUT_MISMATCH: ${path}`);
  const manifest=json(join(path,manifestName)),files=inventory(path);
  if(manifest.format!==format || manifest.componentId!==componentId || manifest.payloadHash!==payloadHash(files,manifest.runtime,manifest.runtimePackages) || JSON.stringify(manifest.files)!==JSON.stringify(files) || manifest.bytes!==files.reduce((sum,file)=>sum+file.size,0) || JSON.stringify(manifest.systemRequirements)!==JSON.stringify(manifest.runtime.systemRequirements)) fail(`IMMUTABLE_OUTPUT_MISMATCH: ${path}`);
  return {...manifest,path};
}
