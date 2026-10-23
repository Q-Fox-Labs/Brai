// ABOUTME: Проверяет границу защитного hook на нативных формах входа PreToolUse.
// ABOUTME: Подмена клиента проверяет решения политики, но не подтверждает установку hook в Codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, symlink, rm} from 'node:fs/promises';
import path from 'node:path';
import {runHook, writePaths} from '../src/hook.mjs';

const root = '/test/main';
const config = {projects: [{id: 'demo', repo_path: root, documentation_paths: ['docs/allowed.md'], excluded_paths: ['tmp']}]};
const env = {CODEWORKS_WORKSPACE_KEY: 'task-1'};
const accepted = {operation_id: '00000000-0000-4000-8000-000000000002', workspace_id: '00000000-0000-4000-8000-000000000001', path: '/test/worktree', branch: 'codex/task-1'};
const patch = command => ({hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: root, tool_input: {command}});
const bash = command => ({hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: {command}});

function fixture(extra = {}) {
  const calls = [];
  let closes = 0;
  return {calls, get closes() { return closes; }, options: {config, env, connect: async () => ({call: async (method, args) => { calls.push({method, args}); return accepted; }, close: () => { closes++; }}), ...extra}};
}

for (const operation of ['Add File: src/new.mjs\n+new', 'Delete File: src/old.mjs', 'Update File: src/old.mjs\n*** Move to: src/moved.mjs\n@@\n-old\n+new']) {
  test(`patch ${operation.split('\n')[0]} prepares and denies without rewriting`, async () => {
    const f = fixture();
    const result = await runHook(patch(`*** Begin Patch\n*** ${operation}\n*** End Patch`), f.options);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.additionalContext, /\/test\/worktree/);
    assert.match(result.hookSpecificOutput.additionalContext, /ready/);
    assert.equal(f.calls[0].method, 'prepare');
    assert.equal(f.calls[0].args.project_id, 'demo');
    assert.equal(f.calls[0].args.workspace_key, 'task-1');
    assert.equal(f.closes, 1);
    assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  });
}

test('patch move protects destination even when source is outside main', async () => {
  const f = fixture();
  await runHook(patch('*** Update File: /outside/a\n*** Move to: /test/main/new\n@@\n-a\n+b'), f.options);
  assert.equal(f.calls.length, 1);
});

test('reads, diagnostics, allowed docs and worktree edits never connect', async () => {
  const connect = () => assert.fail('read or exception must not connect');
  for (const event of [bash('git status --short'), bash('cat src/main.mjs'), bash('git status # > /test/main/comment-only'), bash("echo 'x > /test/main/no-write'"), patch('*** Update File: docs/allowed.md\n@@\n-a\n+b'), patch('*** Add File: tmp/a\n+a'), {...patch('*** Add File: src/a\n+a'), cwd: '/test/worktree'}, {...patch(''), tool_name: 'Read', tool_input: {file_path: '/test/main/src/a'}}]) {
    assert.deepEqual(await runHook(event, {config, env, connect}), {});
  }
});

test('mixed docs and code patch uses one prepare', async () => {
  const f = fixture();
  await runHook(patch('*** Update File: docs/allowed.md\n@@\n-a\n+b\n*** Add File: src/a\n+a'), f.options);
  assert.equal(f.calls.length, 1);
});

test('direct Edit, Write and MultiEdit guard the named file', async () => {
  for (const tool_name of ['Edit', 'Write', 'MultiEdit']) {
    const f = fixture();
    const result = await runHook({tool_name, cwd: root, tool_input: {file_path: 'src/a'}}, f.options);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  }
});

for (const command of ["echo 'hello' > src/a", 'cat > /test/main/src/a', 'touch src/a', 'rm -f src/a', 'mv /outside/a src/a', 'mv src/a /outside/a', 'cp /outside/a src/a', 'cp -t /test/main /outside/a', 'cp --target-directory=/test/main /outside/a', "sed -i 's/a/b/' src/a", 'printf test | tee src/a', 'cd /test/main && touch src/a', 'rtk proxy rm src/a']) {
  test(`recognizes simple shell write: ${command}`, async () => {
    const f = fixture();
    const result = await runHook(bash(command), f.options);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(f.calls.length, 1);
  });
}

test('native exec_command uses its explicit workdir', () => {
  assert.deepEqual(writePaths({tool_name: 'functions.exec_command', cwd: '/outside', tool_input: {cmd: 'touch src/a', workdir: root}}), ['/test/main/src/a']);
});

test('unrecognized shell stays outside the hook contract', async () => {
  assert.deepEqual(await runHook(bash('python3 script.py'), fixture().options), {});
});

test('unavailable Codeworks blocks only the identified write and preserves stable retry key', async () => {
  const requests = [];
  const options = {...fixture().options, connect: async () => ({call: async (method, args) => { requests.push(args); throw new Error('private backend detail'); }, close() {}})};
  const event = bash('touch src/a');
  for (let i = 0; i < 2; i++) {
    const result = await runHook(event, options);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.additionalContext, /request_key/);
    assert.doesNotMatch(JSON.stringify(result), /private backend detail/);
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(await runHook(bash('git log -1'), options), {});
  assert.equal(requests.length, 2);
});

test('workspace key hint selects one area, absent hint does not guess', async () => {
  const f = fixture({env: {}});
  const denied = await runHook(bash('touch src/a'), f.options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.calls.length, 0);
  await runHook({...bash('touch src/a'), session_id: 'chat-2'}, f.options);
  assert.equal(f.calls[0].args.workspace_key, 'chat-2');
});

test('two protected projects require explicit separate requests', async () => {
  const f = fixture({config: {projects: [...config.projects, {id: 'other', repo_path: '/other/main'}]}});
  const result = await runHook(patch('*** Add File: src/a\n+a\n*** Add File: /other/main/b\n+b'), f.options);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(f.calls.length, 0);
});

test('new file through symlink resolves to protected main', async () => {
  const directory = await mkdtemp('/tmp/codeworks-hook-');
  try {
    await mkdir(path.join(directory, 'main'));
    await symlink(path.join(directory, 'main'), path.join(directory, 'alias'));
    const f = fixture({config: {projects: [{id: 'demo', repo_path: path.join(directory, 'main')}]}});
    const result = await runHook({tool_name: 'Write', cwd: directory, tool_input: {file_path: 'alias/new-file'}}, f.options);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('invalid new task key asks for a readable name without creating a second area',async()=>{
  const f=fixture({connect:async()=>({call:async()=>{throw Object.assign(new Error('invalid key'),{code:'INVALID_ARGUMENT'});},close:async()=>{}})});
  const result=await runHook(bash('touch src/a'),f.options);
  assert.equal(result.hookSpecificOutput.permissionDecision,'deny');
  assert.match(result.hookSpecificOutput.additionalContext,/осмысленным workspace_key/);
  assert.match(result.hookSpecificOutput.additionalContext,/status/);
});
