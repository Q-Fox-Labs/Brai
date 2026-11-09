// ABOUTME: Запускает автономные проверки комплекта расширений Hermes.
// ABOUTME: Не требует сети, установленного движка или пользовательского профиля.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildOutputInventory } from '../../codeworks/components/cli.mjs';

test('delivery includes every extension file and the GIF skill', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const component = JSON.parse(readFileSync(new URL('../component.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../extensions/manifest.json', import.meta.url), 'utf8'));
  const delivered = new Set(buildOutputInventory(root, component).map(item => item.path));
  for (const relative of [...manifest.runtimeFiles, 'manifest.json']) {
    const path = `services/hermes/extensions/${relative}`;
    assert.ok(delivered.has(path), `Missing delivered extension: ${path}`);
  }
  const skill = 'docs/user-agent/instructions/hermes/skills/creative/context-gifs/SKILL.md';
  assert.ok(delivered.has(skill), `Missing delivered skill: ${skill}`);
});

test('extensions connect and codex owner', { timeout: 60000 }, () => {
  for (const name of ['test_skill_docs.py', 'test_connect.py', 'test_context_gif.py', 'test_shared_codex_search.py', 'test_skill_helpers.py', 'test_codex_cli_owner.py', 'test_memory_quality.py', 'test_memory_bridge.py', 'test_conversation_approval.py', 'test_native_conversation.py', 'test_native_memory.py']) {
    const script = fileURLToPath(new URL(`../extensions/tests/${name}`, import.meta.url));
    const result = spawnSync('python3', ['-B', script], { encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});


test('video helper uses real local FFmpeg fixtures', { timeout: 60000 }, () => {
  const script = fileURLToPath(new URL('../extensions/skill-scripts/media/youtube-content/scripts/test_video_workflow.py', import.meta.url));
  const result = spawnSync('python3', ['-B', script], { encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
