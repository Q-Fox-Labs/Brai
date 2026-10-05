// ABOUTME: Измеряет запуск, работу, остановку и повторный запуск закреплённого llama.cpp runner.
// ABOUTME: Запускать только через Ansible; не очищает кеши хоста и не касается production-процесса.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const runnerDirectory = path.dirname(fileURLToPath(import.meta.url));
const profilePath = path.resolve(runnerDirectory, "../../profiles/llama_cpp.json");
const verifierPath = path.join(runnerDirectory, "verify.mjs");
await access(profilePath, constants.R_OK);
const profile = JSON.parse(await readFile(profilePath, "utf8"));
assert.equal(profile.profileId, "llama_cpp", "runner must load the llama_cpp profile");
const executable = process.env.BRAI_LLAMA_SERVER_PATH;
const modelPath = process.env.BRAI_LLAMA_MODEL_PATH;
const libraryPath = process.env.BRAI_LLAMA_LD_LIBRARY_PATH;
const referenceUrl = process.env.BRAI_EMBEDDINGS_REFERENCE_URL;
const reference = referenceUrl ? new URL(referenceUrl) : undefined;
const host = "127.0.0.1";
const port = Number(process.env.BRAI_LLAMA_TEST_PORT ?? "19339");
const referencePort = reference?.port ? Number(reference.port) : 80;
const readinessTimeoutMs = 60_000;
const stopGraceMs = 20_000;
const killGraceMs = 5_000;

assert.ok(executable?.startsWith("/"), "BRAI_LLAMA_SERVER_PATH must be an absolute prepared executable path");
assert.ok(modelPath?.startsWith("/"), "BRAI_LLAMA_MODEL_PATH must be an absolute prepared model path");
assert.ok(libraryPath, "BRAI_LLAMA_LD_LIBRARY_PATH must contain the prepared runtime libraries");
assert.ok(reference && reference.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(reference.hostname) &&
  !reference.username && !reference.password && reference.pathname === "/" &&
  !reference.search && !reference.hash,
"BRAI_EMBEDDINGS_REFERENCE_URL must be a plain loopback HTTP origin");
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && port !== referencePort,
  "test port must be a non-privileged loopback port separate from the reference runtime");
await access(executable, constants.X_OK);
await access(modelPath, constants.R_OK);

const args = profile.engine.args.map(value => {
  if (value === "{{modelPath}}") return modelPath;
  if (value === "{{port}}") return String(port);
  return value;
});
assert.ok(!args.some(value => value.includes("{{")), "profile arguments must be fully substituted");

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function assertPortClosed() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`test port ${port} still has a listener`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`test port ${port} did not refuse a connection`));
    });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

async function processHighWaterBytes(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

function groupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupExit(processGroupId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (groupExists(processGroupId)) {
    if (performance.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function readHostSnapshot() {
  const [loadavg, meminfo] = await Promise.all([
    readFile("/proc/loadavg", "utf8"),
    readFile("/proc/meminfo", "utf8"),
  ]);
  const loads = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  const values = Object.fromEntries([...meminfo.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)]
    .map(match => [match[1], Number(match[2]) * 1024]));
  return {
    cpuCountVisible: os.availableParallelism(),
    loadAverage1m5m15m: loads,
    memTotalBytes: values.MemTotal,
    memAvailableBytes: values.MemAvailable,
  };
}

async function waitUntilReady(child) {
  const deadline = performance.now() + readinessTimeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`llama-server exited before readiness (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    try {
      const response = await fetch(`http://${host}:${port}${profile.api.healthPath}`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // The process may still be loading its model before the HTTP listener is ready.
    }
    await delay(200);
  }
  throw new Error(`llama-server readiness exceeded ${readinessTimeoutMs} ms`);
}

async function runVerifier(label) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [verifierPath, `http://${host}:${port}`], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BRAI_EMBEDDINGS_REFERENCE_URL: referenceUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout = (stdout + chunk).slice(-16_385);
  });
  child.stderr.setEncoding("utf8").on("data", chunk => {
    stderr = (stderr + chunk).slice(-2_000);
  });
  let timedOut = false;
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.equal(timedOut, false, `${label} HTTP verifier exceeded 120 seconds`);
  assert.equal(exit.code, 0,
    `${label} HTTP verifier failed${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ""}`);
  assert.ok(stdout.length <= 16_384, `${label} verifier output exceeded the summary-only limit`);
  return {
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    checks: JSON.parse(stdout.trim()),
  };
}

async function startAndMeasure(label) {
  await assertPortClosed();
  const start = performance.now();
  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LD_LIBRARY_PATH: libraryPath,
    },
    detached: true,
    stdio: "ignore",
  });
  const spawnResult = await new Promise(resolve => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", error => resolve({ ok: false, error }));
  });
  assert.ok(spawnResult.ok, `llama-server could not start: ${spawnResult.error?.code ?? "spawn error"}`);
  assert.ok(child.pid, "llama-server child process must have a PID");
  const processGroupId = child.pid;
  let peakRssBytes = 0;
  const sampler = setInterval(async () => {
    try {
      peakRssBytes = Math.max(peakRssBytes, await processHighWaterBytes(child.pid));
    } catch {
      // Preserve the last available kernel high-water sample during process exit.
    }
  }, 50);
  let exitInfo;
  const childExit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await waitUntilReady(child);
    const readyMs = Number((performance.now() - start).toFixed(1));
    const http = await runVerifier(label);
    peakRssBytes = Math.max(peakRssBytes, await processHighWaterBytes(child.pid));

    const stopStart = performance.now();
    try {
      process.kill(-processGroupId, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    let groupGone = await waitForGroupExit(processGroupId, stopGraceMs);
    let forcedKill = false;
    if (!groupGone) {
      forcedKill = true;
      process.kill(-processGroupId, "SIGKILL");
      groupGone = await waitForGroupExit(processGroupId, killGraceMs);
    }
    assert.ok(groupGone, `${label} process group did not exit after bounded TERM/KILL`);
    exitInfo = await Promise.race([childExit, delay(1_000).then(() => null)]);
    assert.ok(exitInfo, `${label} llama-server leader exit was not observed`);
    const stopMs = Number((performance.now() - stopStart).toFixed(1));
    await assertPortClosed();

    return {
      startMs: readyMs,
      peakRssBytes,
      http,
      stopMs,
      exitCode: exitInfo.code,
      exitSignal: exitInfo.signal,
      forcedKill,
      processGroupGone: groupGone,
      portClosed: true,
    };
  } catch (error) {
    let cleanupGroupGone = true;
    if (groupExists(processGroupId)) {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* The group may have exited concurrently. */ }
      cleanupGroupGone = await waitForGroupExit(processGroupId, killGraceMs);
    }
    exitInfo = await Promise.race([childExit, delay(1_000).then(() => null)]);
    if (!cleanupGroupGone || !exitInfo) {
      throw new AggregateError([error], "llama-server cleanup did not finish within the bounded grace period");
    }
    throw error;
  } finally {
    clearInterval(sampler);
  }
}

const hostBefore = await readHostSnapshot();
const initial = await startAndMeasure("first start");
const reload = await startAndMeasure("reload");
const hostAfter = await readHostSnapshot();

console.log(JSON.stringify({
  ok: true,
  profileId: profile.profileId,
  modelId: profile.modelId,
  image: profile.engine.image,
  modelSha256: profile.source.files[0].sha256,
  configuredLimits: profile.limits,
  testPort: port,
  referencePort,
  hostBefore,
  firstProcessStart: initial,
  reload: {
    ...reload,
    startMs: Number(reload.startMs.toFixed(1)),
  },
  hostAfter,
  measurementsExcludeColdOsPageCache: true,
}));
