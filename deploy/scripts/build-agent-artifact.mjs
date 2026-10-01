#!/usr/bin/env node
// ABOUTME: Собирает переносимый артефакт host-agent из точной Git-ревизии.
// ABOUTME: Работает только с явными путями и не запускает собранный сервис.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cp,
  lstat,
  open,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink as readLink,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NODE_VERSION = '24.21.0';
const NPM_VERSION = '11.19.0';
const AGENT_NAME = '@brai/agent';
const ARCHIVE_PATHS = [
  'package.json',
  'package-lock.json',
  'apps/web/package.json',
  'services/auth/package.json',
  'services/timer/package.json',
  'services/agent/package.json',
  'services/agent/tsconfig.json',
  'services/agent/src',
  'services/agent/contracts/index.mjs',
  'services/agent/contracts/index.d.mts',
  'services/agent/contracts/codex/openrpc.json',
  'services/agent/contracts/codex/schema.json',
  'services/agent/schemas/messages.schema.json',
];
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--source', '--revision', '--output'].includes(key) || values.has(key)) {
      fail('Usage: build-candidate.mjs --source <Git-root> --revision <40-hex-commit> --output <new-absolute-path>');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  if (values.size !== 3) fail('Usage: build-candidate.mjs --source <Git-root> --revision <40-hex-commit> --output <new-absolute-path>');
  const source = values.get('--source');
  const revision = values.get('--revision');
  const output = values.get('--output');
  if (!path.isAbsolute(source) || !path.isAbsolute(output)) fail('--source and --output must be absolute paths');
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('--revision must be a lowercase 40-character Git commit');
  return { source: path.normalize(source), revision, output: path.normalize(output) };
}

async function resolvePackageRoot(requireFrom, name, root) {
  const resolved = await realpath(requireFrom.resolve(name));
  if (!isWithin(root, resolved)) fail(`Dependency resolves outside build scratch: ${name}`);
  let directory = path.dirname(resolved);
  while (isWithin(root, directory)) {
    const manifestPath = path.join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.name === name) return { root: directory, manifest };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  fail(`Could not locate package metadata for ${name}`);
}

async function collectProductionGraph(agentRoot, root) {
  const agentManifest = JSON.parse(await readFile(path.join(agentRoot, 'package.json'), 'utf8'));
  const queue = Object.keys(agentManifest.dependencies ?? {})
    .map((name) => ({ requireFrom: createRequire(path.join(agentRoot, 'package.json')), name, optional: false }));
  const graph = new Map();
  while (queue.length) {
    const item = queue.shift();
    let resolved;
    try {
      resolved = await resolvePackageRoot(item.requireFrom, item.name, root);
    } catch (error) {
      if (item.optional) continue;
      throw error;
    }
    const relative = path.relative(root, resolved.root).split(path.sep).join('/');
    if (graph.has(relative)) continue;
    graph.set(relative, { name: resolved.manifest.name, version: resolved.manifest.version, path: relative });
    const nextRequire = createRequire(path.join(resolved.root, 'package.json'));
    for (const name of Object.keys(resolved.manifest.dependencies ?? {})) queue.push({ requireFrom: nextRequire, name, optional: false });
    for (const name of Object.keys(resolved.manifest.optionalDependencies ?? {})) queue.push({ requireFrom: nextRequire, name, optional: true });
    for (const name of Object.keys(resolved.manifest.peerDependencies ?? {})) {
      queue.push({ requireFrom: nextRequire, name, optional: resolved.manifest.peerDependenciesMeta?.[name]?.optional === true });
    }
  }
  return [...graph.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertTrackedInputsAreRegularFiles(source, revision) {
  const raw = run('git', ['ls-tree', '-r', '-z', revision, '--', ...ARCHIVE_PATHS], { cwd: source });
  for (const record of raw.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator < 0) fail('Could not inspect the tracked archive input');
    const metadata = record.slice(0, separator).split(' ');
    const mode = metadata[0];
    const name = record.slice(separator + 1);
    if (mode !== '100644' && mode !== '100755') fail(`Archive input is not a regular tracked file: ${name}`);
  }
}

async function removeOmittedWorkspaceLinks(nodeModules, artifactRoot) {
  const scopes = await readdir(nodeModules, { withFileTypes: true });
  for (const scope of scopes) {
    const scopePath = path.join(nodeModules, scope.name);
    if (scope.isSymbolicLink()) {
      await removeWorkspaceLink(scopePath, artifactRoot);
      continue;
    }
    if (!scope.isDirectory()) continue;
    for (const entry of await readdir(scopePath, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      await removeWorkspaceLink(path.join(scopePath, entry.name), artifactRoot);
    }
  }
}

async function removeWorkspaceLink(linkPath, artifactRoot) {
  const target = path.resolve(path.dirname(linkPath), await readLink(linkPath));
  if (!isWithin(artifactRoot, target)) fail(`Workspace link escapes output: ${path.relative(artifactRoot, linkPath)}`);
  const agentRoot = path.join(artifactRoot, 'services', 'agent');
  const omittedWorkspace = target.startsWith(path.join(artifactRoot, 'apps') + path.sep)
    || (target.startsWith(path.join(artifactRoot, 'services') + path.sep) && !isWithin(agentRoot, target));
  if (omittedWorkspace) await rm(linkPath);
}

async function verifySymlinksAreContained(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const targetText = await readLink(fullPath);
        const target = path.resolve(path.dirname(fullPath), targetText);
        if (!isWithin(root, target)) fail(`Artifact symlink escapes output: ${path.relative(root, fullPath)}`);
        const realTarget = await realpath(fullPath).catch(() => null);
        if (!realTarget || !isWithin(root, realTarget)) fail(`Artifact symlink is broken or escapes output: ${path.relative(root, fullPath)}`);
      } else if (entry.isDirectory()) {
        await visit(fullPath);
      }
    }
  }
  await visit(root);
}

async function main() {
  const { source: sourceInput, revision, output } = parseArgs(process.argv.slice(2));
  const source = await realpath(sourceInput);
  const outputParent = path.dirname(output);
  if (!path.isAbsolute(outputParent)) fail('--output parent must be an absolute path');
  await stat(outputParent).then((entry) => {
    if (!entry.isDirectory()) fail('--output parent must be an existing directory');
  });
  await lstat(output).then(() => fail('Refusing to overwrite an existing output')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const sourceRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd: source });
  if (path.resolve(sourceRoot) !== source) fail('--source must be the Git repository root');
  const canonicalRevision = run('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: source });
  if (canonicalRevision !== revision) fail('Git did not resolve the requested exact commit');
  const actualNode = process.versions.node;
  if (actualNode !== NODE_VERSION) fail(`Node.js ${NODE_VERSION} is required; found ${actualNode}`);
  const outputRealParent = await realpath(outputParent);
  const outputResolved = path.join(outputRealParent, path.basename(output));
  if (isWithin(source, outputResolved) || isWithin(outputResolved, source)) {
    fail('--output must be outside the source Git root');
  }
  await assertTrackedInputsAreRegularFiles(source, revision);

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'brai-agent-release-build-'));
  const extracted = path.join(scratch, 'source');
  const stage = path.join(scratch, 'artifact');
  let outputCreated = false;
  try {
    await mkdir(extracted);
    await mkdir(stage);
    const npmHome = path.join(scratch, 'npm-home');
    const npmCache = path.join(scratch, 'npm-cache');
    const npmUserConfig = path.join(scratch, 'npm-user.npmrc');
    const npmGlobalConfig = path.join(scratch, 'npm-global.npmrc');
    await mkdir(npmHome);
    await mkdir(npmCache);
    await (await open(npmUserConfig, 'wx', 0o600)).close();
    await (await open(npmGlobalConfig, 'wx', 0o600)).close();
    const npmEnvironment = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: npmHome,
      npm_config_cache: npmCache,
      npm_config_userconfig: npmUserConfig,
      npm_config_globalconfig: npmGlobalConfig,
    };
    const archive = spawnSync('git', ['archive', '--format=tar', revision, '--', ...ARCHIVE_PATHS], {
      cwd: source,
      encoding: 'buffer',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (archive.error) fail(`git archive failed: ${archive.error.message}`);
    if (archive.status !== 0) fail(`git archive exited with ${archive.status}`);
    const unpack = spawnSync('tar', ['-xf', '-', '-C', extracted], {
      input: archive.stdout,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (unpack.error) fail(`tar extraction failed: ${unpack.error.message}`);
    if (unpack.status !== 0) fail(`tar extraction exited with ${unpack.status}`);

    const rootManifest = JSON.parse(await readFile(path.join(extracted, 'package.json'), 'utf8'));
    const agentManifest = JSON.parse(await readFile(path.join(extracted, 'services/agent/package.json'), 'utf8'));
    if (rootManifest.engines?.node !== NODE_VERSION || rootManifest.engines?.npm !== NPM_VERSION
        || rootManifest.packageManager !== `npm@${NPM_VERSION}`) {
      fail('Archived root manifest does not pin the required Node.js/npm versions');
    }
    if (agentManifest.name !== AGENT_NAME) fail(`Expected workspace ${AGENT_NAME}`);

    const actualNpm = run('npm', ['--version'], { cwd: extracted, env: npmEnvironment });
    if (actualNpm !== NPM_VERSION) fail(`npm ${NPM_VERSION} is required; found ${actualNpm}`);
    run('npm', ['ci', '--ignore-scripts', '--workspace=@brai/agent'], { cwd: extracted, env: npmEnvironment, stdio: 'inherit' });
    run('npm', ['run', 'build', '--workspace=@brai/agent'], { cwd: extracted, env: npmEnvironment, stdio: 'inherit' });
    run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--workspace=@brai/agent'], { cwd: extracted, env: npmEnvironment, stdio: 'inherit' });

    const agentRoot = path.join(extracted, 'services', 'agent');
    await cp(path.join(extracted, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await mkdir(path.join(stage, 'services/agent'), { recursive: true });
    await cp(path.join(agentRoot, 'package.json'), path.join(stage, 'services/agent/package.json'));
    await lstat(path.join(agentRoot, 'node_modules')).then(async (entry) => {
      if (!entry.isDirectory()) fail('Agent nested node_modules is not a directory');
      await cp(path.join(agentRoot, 'node_modules'), path.join(stage, 'services/agent/node_modules'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await cp(path.join(agentRoot, 'dist'), path.join(stage, 'services/agent/dist'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await cp(path.join(agentRoot, 'contracts'), path.join(stage, 'services/agent/contracts'), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (sourcePath) => !sourcePath.endsWith('README.md') && !sourcePath.endsWith('manifest.json'),
    });
    await cp(path.join(agentRoot, 'schemas'), path.join(stage, 'services/agent/schemas'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await removeOmittedWorkspaceLinks(path.join(stage, 'node_modules'), stage);
    await verifySymlinksAreContained(stage);

    const dependencyVersions = {};
    const agentRequire = createRequire(path.join(agentRoot, 'package.json'));
    for (const dependencyName of Object.keys(agentManifest.dependencies ?? {}).sort()) {
      const dependency = await resolvePackageRoot(agentRequire, dependencyName, extracted);
      dependencyVersions[dependencyName] = dependency.manifest.version;
    }
    const productionDependencyGraph = await collectProductionGraph(agentRoot, extracted);
    const metadata = {
      format: 'brai-host-agent-artifact-v1',
      sourceRevision: revision,
      nodeVersion: NODE_VERSION,
      npmVersion: NPM_VERSION,
      agentPackage: { name: agentManifest.name, version: agentManifest.version },
      productionDependencies: dependencyVersions,
      productionDependencyGraph,
      entrypoints: ['services/agent/dist/main.js', 'services/agent/dist/health.js'],
    };
    await writeFile(path.join(stage, 'artifact-manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o644 });

    await mkdir(outputResolved);
    outputCreated = true;
    for (const name of await readdir(stage)) {
      await cp(path.join(stage, name), path.join(outputResolved, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true });
    }
    console.log(JSON.stringify({ output: outputResolved, revision, agentVersion: agentManifest.version }));
  } catch (error) {
    if (outputCreated) await rm(outputResolved, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
