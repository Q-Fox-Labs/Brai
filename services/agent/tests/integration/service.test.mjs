// ABOUTME: Проверяет обычный CLI lifecycle и health probe с настоящим Codex socket и NATS.
// ABOUTME: Явный loopback opt-in обязателен; проверка не создаёт threads или turns.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../../dist/config.js";

const configPath = process.env.BRAI_AGENT_CONFIG;
const healthConfigPath = process.env.BRAI_AGENT_TEST_HEALTH_CONFIG || configPath;
const serviceOptIn = process.env.BRAI_AGENT_TEST_SERVICE === "1";
let runtimeConfig;
let healthConfig;
let loopback = false;
let healthLoopback = false;
if (serviceOptIn && configPath && isAbsolute(configPath)) {
  try {
    runtimeConfig = await loadConfig(configPath);
    const servers = runtimeConfig.nats.servers.map((value) => new URL(value));
    loopback = servers.length > 0 && servers.every((server) => server.protocol === "nats:" && ["127.0.0.1", "localhost", "[::1]"].includes(server.hostname));
  } catch { /* opt-in requires a bounded, valid local runtime configuration */ }
}
if (serviceOptIn && healthConfigPath && isAbsolute(healthConfigPath)) {
  try {
    healthConfig = await loadConfig(healthConfigPath);
    const servers = healthConfig.nats.servers.map((value) => new URL(value));
    healthLoopback = servers.length > 0 && servers.every((server) => server.protocol === "nats:" && ["127.0.0.1", "localhost", "[::1]"].includes(server.hostname));
    if (runtimeConfig && JSON.stringify(healthConfig.nats.servers) !== JSON.stringify(runtimeConfig.nats.servers)) healthLoopback = false;
  } catch { /* health uses its own bounded config when its ACL differs */ }
}
const enabled = serviceOptIn && Boolean(runtimeConfig && loopback && healthConfig && healthLoopback);

function keepTail(current, chunk, maximum = 8192) {
  const next = current + chunk;
  return next.length > maximum ? next.slice(-maximum) : next;
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child process shutdown timeout")), timeoutMs);
    timer.unref();
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

test("CLI starts ready and health verifies the assembled Codex/NATS service", { skip: !enabled }, async (t) => {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const service = spawn(process.execPath, ["dist/main.js"], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  service.stdout.setEncoding("utf8").on("data", (value) => { stdout = keepTail(stdout, value); });
  service.stderr.setEncoding("utf8").on("data", (value) => { stderr = keepTail(stderr, value); });
  let stopped = false;
  t.after(async () => {
    if (stopped) return;
    service.kill("SIGTERM");
    try { await waitForClose(service, 20_000); } catch {
      service.kill("SIGKILL");
      await waitForClose(service, 5000);
    }
  });

  const startupDeadline = Date.now() + 30000;
  while (!stdout.includes('"event":"agent.ready"') && Date.now() < startupDeadline && service.exitCode === null)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(stdout.includes('"event":"agent.ready"'), `agent did not become ready; safe stderr: ${stderr.slice(-2000)}`);

  const health = spawn(process.execPath, ["dist/health.js"], { cwd, env: { ...process.env, BRAI_AGENT_CONFIG: healthConfigPath }, stdio: ["ignore", "pipe", "pipe"] });
  let healthOut = "";
  let healthErr = "";
  health.stdout.setEncoding("utf8").on("data", (value) => { healthOut = keepTail(healthOut, value); });
  health.stderr.setEncoding("utf8").on("data", (value) => { healthErr = keepTail(healthErr, value); });
  let healthResult;
  try { healthResult = await waitForClose(health, 15000); }
  finally {
    if (health.exitCode === null && health.signalCode === null) {
      health.kill("SIGTERM");
      try { await waitForClose(health, 5000); } catch { health.kill("SIGKILL"); await waitForClose(health, 5000); }
    }
  }
  assert.equal(healthResult.code, 0, `health failed: ${healthOut} ${healthErr}`);
  assert.match(healthOut, /agent ready/);

  service.kill("SIGTERM");
  const stoppedResult = await waitForClose(service, 20000);
  stopped = true;
  assert.equal(stoppedResult.code, 0);
});
