// ABOUTME: Проверяет состав настоящего prepared web bundle на минимальном workspace.
// ABOUTME: Не устанавливает пакеты и не запускает сборку приложения или Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('prepared web omits development output and keeps production payload and manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brai-web-runtime-test-'));
  const source = join(directory, 'source');
  const output = join(directory, 'runtime');
  await mkdir(source);
  const files = {
    'package.json': JSON.stringify({ name: 'runtime-fixture', private: true }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'apps/web': { name: '@brai/web', version: '1.0.0' } } }),
    'apps/web/package.json': JSON.stringify({ name: '@brai/web', version: '1.0.0' }),
    'apps/web/.next/BUILD_ID': 'production-build',
    'apps/web/.next/server/app/page.js': 'production-server',
    'apps/web/.next/static/chunks/page.js': 'production-client',
    'apps/web/.next/device/keep.js': 'not-development-output',
    'apps/web/.next/dev/cache/turbopack/old': 'development-cache',
    'apps/web/.next/dev/server/old.js': 'development-server',
    'apps/web/.next/cache/webpack/old': 'build-cache',
    'apps/web/.next/trace': 'build-trace',
    'apps/web/public/logo.svg': '<svg/>',
    'apps/web/Dockerfile.prepared': 'FROM node:24.21.0-bookworm-slim\nCOPY . /app/\n',
    'services/artifacts/contracts/index.js': 'artifacts-contract',
    'services/artifacts/schemas/facts.json': '{}',
    'services/alerts/contracts/index.js': 'alerts-contract',
    'services/alerts/schemas/facts.json': '{}',
    'services/agent/package.json': '{}',
    'services/agent/dist/main.js': 'agent-runtime',
    'services/agent/contracts/index.js': 'agent-contract',
  };
  try {
    for (const [name, value] of Object.entries(files)) {
      const path = join(source, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, value);
    }
    const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--initial-branch=dev');
    git('add', '.');
    git('commit', '-m', 'Runtime fixture');
    const revision = git('rev-parse', 'HEAD');
    execFileSync(process.execPath, [new URL('./materialize-runtime.mjs', import.meta.url).pathname,
      '--source', source, '--workspace', '@brai/web', '--revision', revision, '--output', output]);
    for (const name of ['dev', 'cache', 'trace']) {
      await assert.rejects(access(join(output, 'apps/web/.next', name)), { code: 'ENOENT' });
    }
    for (const name of ['BUILD_ID', 'server/app/page.js', 'static/chunks/page.js', 'device/keep.js']) {
      assert.equal(await readFile(join(output, 'apps/web/.next', name), 'utf8'), files['apps/web/.next/' + name]);
    }
    const manifest = JSON.parse(await readFile(join(output, 'runtime-manifest.json'), 'utf8'));
    assert.equal(manifest.sourceRevision, revision);
    assert.equal(manifest.workspace, '@brai/web');
    assert.ok(manifest.payloadFiles.some(item => item.path === 'apps/web/.next/server/app/page.js'));
    assert.ok(manifest.payloadFiles.every(item => !/^apps\/web\/\.next\/(dev|cache|trace)(\/|$)/.test(item.path)));
    assert.equal(await readFile(join(output, 'services/alerts/contracts/index.js'), 'utf8'), 'alerts-contract');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
