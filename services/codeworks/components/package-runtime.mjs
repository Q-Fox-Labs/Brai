// ABOUTME: Собирает неизменяемую поставку компонента из явных файлов и установленного npm lock closure.
// ABOUTME: Не устанавливает зависимости, не собирает исходники и не включает внешние runtime или данные.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { lockInputs } from './lock-inputs.mjs';

const run = promisify(execFile);
const format = 'brai-component-runtime-v1';
const manifestName = 'artifact-manifest.json';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);
const fail = message => { throw new Error(message); };
const present = path => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

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

function collectPackages(root, workspaces) {
  const packages = new Map();
  for (const {key,entry} of lockInputs(root,workspaces)) {
    if (!key.split('/').includes('node_modules')) continue;
    const installed=join(root,key);
    if(!existsSync(installed)) fail(`MISSING_INSTALLED_PACKAGE: ${key}`);
    if(entry.link) {
      const target=repositoryPath(entry.resolved);
      if(!inside(root,realpathSync(installed)) || realpathSync(installed)!==realpathSync(join(root,target)))fail(`WORKSPACE_LINK_MISMATCH: ${key}`);
      const metadata=json(join(root,target,'package.json'));
      packages.set(key,{key,entry,target,version:metadata.version});
    } else {
      const metadata=json(join(installed,'package.json'));
      const name=key.slice(key.lastIndexOf('node_modules/')+'node_modules/'.length);
      if(metadata.name!==(entry.name??name))fail(`PACKAGE_NAME_MISMATCH: ${key}`);
      if(metadata.version!==entry.version)fail(`PACKAGE_VERSION_MISMATCH: ${key}`);
      packages.set(key,{key,entry,installed,version:entry.version});
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
    cpSync(stage, isolated, { recursive: true, dereference: false, verbatimSymlinks: true });
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
      const toolchainPath=join(root,'services/codeworks/ci/toolchain.json');
      const base=existsSync(toolchainPath)?json(toolchainPath).nodeBase:'node:24.22.1-bookworm-slim';
      writeFileSync(join(stage, 'Dockerfile'), `FROM ${base}\nWORKDIR ${JSON.stringify(`/app/${component.directory}`)}\nCOPY . /app\nCMD ${JSON.stringify(command)}\n`);
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
