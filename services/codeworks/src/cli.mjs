#!/usr/bin/env node
// ABOUTME: Передаёт явные JSON-запросы в API жизненного цикла Codeworks.
// ABOUTME: Не исполняет команды агента; справка и схемы доступны без подключения к сервису.
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {methods, expanded, validate} from './contracts.mjs';
import {Fault} from './errors.mjs';
import {connectClient, loadClientConfig} from './client.mjs';

const HELP = `Codeworks: prepare, status, sync, release, cleanup, project.register, project.get
Usage: codeworks --request-json '{"action":"status","project_id":"my_project"}'
       codeworks < request.json
       codeworks --help | --schema
Mutations require an explicit stable request_key. Retry a timeout with the same key;
use status with operation_id to inspect progress. Commit files with native Git tools.
Connection: CODEWORKS_CLIENT_CONFIG or CODEWORKS_NATS_URL,
CODEWORKS_NATS_CONFIG / CODEWORKS_NATS_CREDS_FILE, CODEWORKS_EXECUTOR_ID.
Protected NATS JSON preserves user/pass/inboxPrefix; .creds requires an endpoint.
CODEWORKS_NATS_URL overrides the JSON endpoint; environment overrides public config.
prepare workspace_key may default to CODEWORKS_WORKSPACE_KEY or CODEX_THREAD_ID.
`;

/** Читает единственный JSON-документ UTF-8, не накапливая более 64 KiB. */
export async function readJSON(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65536) throw new Fault('INVALID_ARGUMENT');
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); }
  catch { throw new Fault('INVALID_ARGUMENT'); }
}

/** Выполняет одну CLI-команду и возвращает exit code; зависимости допускают автономную проверку. */
export async function runCLI({argv = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, connect = connectClient} = {}) {
  let client;
  try {
    if (argv.length === 1 && argv[0] === '--help') { stdout.write(HELP); return 0; }
    if (argv.length === 1 && argv[0] === '--schema') {
      const oneOf = methods.map(action => {
        const definition = expanded(action);
        return {...definition, properties: {action: {const: action}, ...definition.properties}, required: ['action', ...(definition.required ?? [])]};
      });
      stdout.write(JSON.stringify({$schema: 'http://json-schema.org/draft-07/schema#', oneOf}) + '\n');
      return 0;
    }
    if (argv.length && (argv.length !== 2 || argv[0] !== '--request-json')) throw new Fault('INVALID_ARGUMENT');
    const request = await readJSON(argv.length ? [argv[1]] : stdin);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Fault('INVALID_ARGUMENT');
    const {action, ...args} = request;
    if (!methods.includes(action)) throw new Fault('INVALID_ARGUMENT');
    if (action === 'prepare') {
      args.kind ??= 'feature';
      args.workspace_key ??= env.CODEWORKS_WORKSPACE_KEY || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
    }
    validate(action, args);
    client = await connect(await loadClientConfig(env));
    stdout.write(JSON.stringify(await client.call(action, args)) + '\n');
    return 0;
  } catch (error) {
    stderr.write(JSON.stringify(error instanceof Fault ? error.dto() : {code: 'CODEWORKS_UNAVAILABLE', message: 'Request failed or timed out. Inspect status or retry with the same request_key.', retryable: true}) + '\n');
    return 1;
  } finally {
    try { await client?.close(); } catch { /* Закрытие не меняет полученный результат операции. */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runCLI();
