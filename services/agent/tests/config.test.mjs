// ABOUTME: Проверяет явные входы, границы и безопасные ошибки конфигурации agent.
// ABOUTME: Использует временный JSON-файл и не открывает конфигурацию окружения.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../dist/config.js";

const fixture = () => ({
  codex: { socketUrl: "ws+unix:/tmp/codex.sock:/" },
  nats: { servers: ["nats://127.0.0.1:24228"], user: "fixture-agent", password: "placeholder-secret", inboxPrefix: "_INBOX.brai_agent" },
  projects: [{ projectId: "fixture", name: "Fixture", cwd: "/tmp/project" }],
  allowedModels: ["gpt-6.1-sol"],
  newThread: { approvalsReviewer: "user" },
});

test("config accepts explicit endpoints, project, model allowlist and reviewer", () => {
  assert.deepEqual(parseConfig(fixture()), {
    ...fixture(),
    nats: { ...fixture().nats, servers: ["nats://127.0.0.1:24228"] },
    projects: [{ projectId: "fixture", name: "Fixture", cwd: "/tmp/project" }],
  });
});

test("config rejects unapproved keys, endpoints, IDs and relative cwd without echoing values", () => {
  const cases = [
    { ...fixture(), unexpected: "secret-value" },
    { ...fixture(), codex: { socketUrl: "ws+unix:relative.sock:/" } },
    { ...fixture(), codex: { socketUrl: "ws+unix:/tmp/a.sock:/?token=secret" } },
    { ...fixture(), nats: { ...fixture().nats, servers: ["nats://user:secret@127.0.0.1:4222"] } },
    { ...fixture(), nats: { ...fixture().nats, inboxPrefix: "_INBOX.>" } },
    { ...fixture(), projects: [{ projectId: "bad id", name: "Fixture", cwd: "relative" }] },
    { ...fixture(), newThread: { approvalsReviewer: "other" } },
  ];
  for (const value of cases) {
    assert.throws(() => parseConfig(value), (error) => error.message === "INVALID_AGENT_CONFIG" && !error.message.includes("secret"));
  }
});

test("loadConfig requires an absolute BRAI_AGENT_CONFIG path and bounds the file read", async () => {
  await assert.rejects(loadConfig("relative.json"), /ABSOLUTE_PATH_REQUIRED/);
  const directory = await mkdtemp(join(tmpdir(), "brai-agent-config-test-"));
  const path = join(directory, "agent.json");
  try {
    await writeFile(path, JSON.stringify(fixture()));
    assert.equal((await loadConfig(path)).projects[0].projectId, "fixture");
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    await assert.rejects(loadConfig(path), /INVALID_AGENT_CONFIG/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
