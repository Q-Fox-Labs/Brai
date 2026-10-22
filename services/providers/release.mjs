// ABOUTME: Собирает закрытый providers runtime из принятого Git SHA и готовых locked packages.
// ABOUTME: Не устанавливает зависимости и не копирует credentials, worktree links или прикладные данные.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const service = 'services/providers';
const helperRoot = dirname(fileURLToPath(import.meta.url));
const assets = [
  'services/providers/release.mjs', 'services/providers/package.json', 'services/providers/catalog.json', 'services/providers/litellm.yaml',
  'services/providers/schemas/v0.schema.json', 'services/providers/schemas/v1.schema.json',
  'services/providers/migrations/001_operations.sql', 'services/providers/migrations/002_outputs.sql',
  'services/providers/migrations/003_observation.sql',
  'services/artifacts/contracts/index.mjs', 'services/artifacts/contracts/index.d.mts', 'services/artifacts/schemas/messages.schema.json',
];
const entrypoints = ['main.js', 'migrate.js', 'chat-http.js', 'observation.js', 'observation-postgres.js'];
const fail = code => { throw new Error(code); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const accepted = (revision, path) => execFileSync('/usr/bin/git', ['show', `${revision}:${path}`], { cwd: root, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();

function candidates(consumer, name) {
  const paths = [];
  for (let cursor = consumer; cursor && cursor !== '.'; cursor = dirname(cursor)) paths.push(`${cursor}/node_modules/${name}`);
  paths.push(`node_modules/${name}`);
  return paths;
}
function packages(lock, manifest) {
  const queue = Object.keys(manifest.dependencies).map(name => ({ from: service, name, optional: false }));
  const found = new Map();
  while (queue.length) {
    if (queue.length > 4096 || found.size > 512) fail('PACKAGE_CLOSURE_LIMIT');
    const request = queue.pop();
    const key = candidates(request.from, request.name).find(key => lock.packages[key]);
    if (!key || !existsSync(join(root, key, 'package.json'))) {
      if (request.optional) continue;
      fail('MISSING_PREPARED_PACKAGE');
    }
    if (found.has(key)) continue;
    const pinned = lock.packages[key];
    const installed = json(join(root, key, 'package.json'));
    if (pinned.link || installed.name !== request.name || installed.version !== pinned.version) fail('PACKAGE_LOCK_MISMATCH');
    found.set(key, { name: installed.name, version: installed.version, integrity: pinned.integrity ?? null });
    for (const name of Object.keys(pinned.dependencies ?? {})) queue.push({ from: key, name, optional: false });
    for (const name of Object.keys(pinned.optionalDependencies ?? {})) queue.push({ from: key, name, optional: true });
    for (const name of Object.keys(pinned.peerDependencies ?? {})) queue.push({ from: key, name, optional: pinned.peerDependenciesMeta?.[name]?.optional === true });
  }
  return found;
}
function payload(directory) {
  const files = [];
  let bytes = 0;
  const visit = path => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) fail('ARTIFACT_SYMLINK');
    if (info.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!info.isFile() || info.size > 32 * 1024 * 1024) fail('ARTIFACT_FILE_LIMIT');
    bytes += info.size;
    if (bytes > 512 * 1024 * 1024 || files.length >= 20000) fail('ARTIFACT_RESOURCE_LIMIT');
    const pathInArtifact = relative(directory, path).split(sep).join('/');
    if (pathInArtifact === 'runtime-manifest.json') return;
    files.push({ path: pathInArtifact, size: info.size, sha256: sha(readFileSync(path)) });
  };
  visit(directory);
  return files;
}
function smoke(directory) {
  execFileSync('/usr/local/bin/node', ['--input-type=module', '-e', "await Promise.all(['pg','nats','ajv'].map(name=>import(name))); await import('./services/providers/dist/artifacts.js'); await import('./services/providers/dist/chat-http.js');"], {cwd:directory, env:{}, timeout:30000, stdio:'pipe'});
}

/** Проверяет source/lock или создаёт новый закрытый artifact; существующее назначение не заменяет. */
async function main() {
  const [mode, revision, output] = process.argv.slice(2);
  if (!['check-source', 'materialize'].includes(mode) || !/^[0-9a-f]{40}$/.test(revision ?? '') || process.version !== 'v24.22.1') fail('INVALID_RELEASE_INPUT');
  if (realpathSync(root) !== root) fail('SOURCE_ROOT_INVALID');
  git(['merge-base', '--is-ancestor', revision, 'HEAD']);
  const sourceFiles = git(['ls-tree', '-r', '--name-only', revision, service]).split('\n')
    .filter(path => /\.ts$/.test(path) || path.endsWith('/tsconfig.json'));
  for (const path of [...assets, ...sourceFiles]) {
    if (!lstatSync(join(root, path)).isFile() || !readFileSync(join(root, path)).equals(accepted(revision, path))) fail('ACCEPTED_SOURCE_CHANGED');
  }
  // AIDEV-NOTE: Чужие manifests/alerts могут быть dirty; runtime lock читается только из принятого Git object.
  const lock = JSON.parse(accepted(revision, 'package-lock.json'));
  const manifest = JSON.parse(accepted(revision, `${service}/package.json`));
  for (const key of ['node_modules/typescript', 'node_modules/@types/node', 'node_modules/@types/pg']) {
    if (json(join(root, key, 'package.json')).version !== lock.packages[key]?.version) fail('BUILD_PACKAGE_LOCK_MISMATCH');
  }
  const sorted = object => JSON.stringify(Object.fromEntries(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  if (lock.lockfileVersion !== 3 || manifest.name !== '@brai/providers' || sorted(lock.packages[service]?.dependencies) !== sorted(manifest.dependencies)) fail('SERVICE_LOCK_MISMATCH');
  const closure = packages(lock, manifest);
  for (const path of assets) if (!lstatSync(join(root, path)).isFile()) fail('MISSING_PUBLIC_ASSET');
  if (mode === 'check-source') {
    if (output !== undefined) fail('INVALID_RELEASE_INPUT');
    console.log(JSON.stringify({ sourceRevision: revision, publicAssets: assets.length, lockedPackages: closure.size }));
    return;
  }
  if (![ `/var/lib/brai-dev/providers/releases/${revision}` ].includes(output) || existsSync(output)) fail('OUTPUT_NOT_NEW_OWN_ARTIFACT');

  mkdirSync(output, { mode: 0o700 });
  try {
    const buildStage = join(output, '.accepted-source');
    mkdirSync(buildStage);
    try {
      for (const path of [...assets, ...sourceFiles]) {
        mkdirSync(dirname(join(buildStage, path)), { recursive: true });
        writeFileSync(join(buildStage, path), accepted(revision, path));
      }
      symlinkSync(join(root, 'node_modules'), join(buildStage, 'node_modules'), 'dir');
      symlinkSync(join(root, service, 'node_modules'), join(buildStage, service, 'node_modules'), 'dir');
      execFileSync('/usr/local/bin/node', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(buildStage, service, 'tsconfig.json'), '--outDir', join(output, service, 'dist')], { timeout: 120000, stdio: 'pipe', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
    } finally { rmSync(buildStage, { recursive: true, force: true }); }
    for (const path of entrypoints) if (!lstatSync(join(output, service, 'dist', path)).isFile()) fail('COMPILED_ENTRYPOINT_MISSING');
    for (const path of assets) {
      mkdirSync(dirname(join(output, path)), { recursive: true });
      writeFileSync(join(output, path), accepted(revision, path));
    }
    for (const [key] of closure) {
      mkdirSync(dirname(join(output, key)), { recursive: true });
      cpSync(join(root, key), join(output, key), { recursive: true, dereference: true,
        filter: path => !['node_modules', '.git', '.secrets'].includes(basename(path)) && !/^\.env(?:\.|$)/.test(basename(path)) });
    }
    await smoke(output);
    const files = payload(output);
    const digest = sha(files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
    writeFileSync(join(output, 'runtime-manifest.json'), JSON.stringify({ format: 'brai-providers-runtime-v1', sourceRevision: revision,
      nodeVersion: '24.22.1', publicAssets: assets, packages: [...closure].map(([path, metadata]) => ({ path, ...metadata })), files, payloadSha256: digest }) + '\n', { flag: 'wx' });
    const readonly = path => { const info = lstatSync(path); if (info.isDirectory()) { for (const name of readdirSync(path)) readonly(join(path,name)); chmodSync(path,0o555); } else chmodSync(path,0o444); };
    readonly(output);
    console.log(JSON.stringify({ sourceRevision: revision, lockedPackages: closure.size, publicAssets: assets.length, payloadSha256: digest }));
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}
try { await main(); }
catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : /^[A-Z_]+$/.test(error.code) ? error.code : 'PROVIDERS_RELEASE_FAILED') + '\n'); process.exitCode = 1; }
