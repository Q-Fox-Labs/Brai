// ABOUTME: Загружает явную конфигурацию исполняемого процесса agent.
// ABOUTME: Не читает файлы admin и не выводит значения секретов в диагностику.

import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateDto } from "../contracts/index.mjs";

export type AgentConfig = {
  codex: { socketUrl: string };
  nats: {
    servers: string[];
    user?: string;
    password?: string;
    inboxPrefix: string;
  };
  projects: { projectId: string; name: string; cwd: string; available?: boolean }[];
  allowedModels?: string[];
  newThread?: { approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null };
};

function invalid(): never {
  throw new Error("INVALID_AGENT_CONFIG");
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function validNatsServer(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "nats:" || url.protocol === "tls:") && Boolean(url.hostname) && (url.pathname === "/" || url.pathname === "") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Проверяет форму конфигурации, не включая её содержимое в ошибки. */
export function parseConfig(value: unknown): AgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, any>;
  keysOnly(raw, ["codex", "nats", "projects", "allowedModels", "newThread"]);
  if (!raw.codex || typeof raw.codex !== "object" || Array.isArray(raw.codex)) invalid();
  keysOnly(raw.codex, ["socketUrl"]);
  if (typeof raw.codex.socketUrl !== "string" || !/^ws\+unix:(\/[^?#\s]+):\/$/.test(raw.codex.socketUrl)) invalid();
  if (raw.codex.socketUrl.slice("ws+unix:".length, -2).split("/").some((part: string) => part === "." || part === "..")) invalid();
  if (!raw.nats || !(typeof raw.nats.servers === "string" || Array.isArray(raw.nats.servers))) invalid();
  if (typeof raw.nats !== "object" || Array.isArray(raw.nats)) invalid();
  keysOnly(raw.nats, ["servers", "user", "password", "inboxPrefix"]);
  const servers = (Array.isArray(raw.nats.servers) ? raw.nats.servers : [raw.nats.servers]) as unknown[];
  if (!servers.length || servers.some((server) => typeof server !== "string" || !validNatsServer(server))) invalid();
  if ((raw.nats.user === undefined) !== (raw.nats.password === undefined)) invalid();
  if (raw.nats.user !== undefined && (typeof raw.nats.user !== "string" || !raw.nats.user || typeof raw.nats.password !== "string" || !raw.nats.password)) invalid();
  const inboxPrefix = raw.nats.inboxPrefix ?? "_INBOX.brai_agent";
  if (typeof inboxPrefix !== "string" || !inboxPrefix || /\s|\*|>|\\/.test(inboxPrefix) || inboxPrefix.split(".").some((part) => !part)) invalid();
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) invalid();
  const projects = raw.projects.map((project: any) => {
    if (!project || typeof project !== "object" || Array.isArray(project)) invalid();
    keysOnly(project, ["projectId", "name", "cwd", "available"]);
    if (typeof project.projectId !== "string" || typeof project.name !== "string" || typeof project.cwd !== "string" || !isAbsolute(project.cwd)) invalid();
    if (project.available !== undefined && typeof project.available !== "boolean") invalid();
    return { projectId: project.projectId, name: project.name, cwd: project.cwd, ...(project.available === undefined ? {} : { available: project.available }) };
  });
  if (new Set(projects.map((project: AgentConfig["projects"][number]) => project.projectId)).size !== projects.length) invalid();
  if (!validateDto("ProjectsResponse", { generation: "00000000-0000-4000-8000-000000000000", projects: projects.map((project: AgentConfig["projects"][number]) => ({ projectId: project.projectId, name: project.name, available: project.available !== false })) })) invalid();
  if (raw.allowedModels !== undefined && (!Array.isArray(raw.allowedModels) || raw.allowedModels.some((model: unknown) => typeof model !== "string" || !model))) invalid();
  if (raw.newThread !== undefined && (!raw.newThread || typeof raw.newThread !== "object" || Array.isArray(raw.newThread))) invalid();
  if (raw.newThread !== undefined) keysOnly(raw.newThread, ["approvalsReviewer"]);
  const reviewer = raw.newThread?.approvalsReviewer;
  if (reviewer !== undefined && reviewer !== null && !["user", "auto_review", "guardian_subagent"].includes(reviewer)) invalid();
  return {
    codex: { socketUrl: raw.codex.socketUrl },
    nats: { servers: servers as string[], ...(raw.nats.user === undefined ? {} : { user: raw.nats.user, password: raw.nats.password }), inboxPrefix },
    projects,
    ...(raw.allowedModels === undefined ? {} : { allowedModels: [...raw.allowedModels] }),
    ...(raw.newThread === undefined ? {} : { newThread: { ...(reviewer === undefined ? {} : { approvalsReviewer: reviewer }) } }),
  };
}

/** Читает JSON только из пути, заданного BRAI_AGENT_CONFIG. */
export async function loadConfig(path = process.env.BRAI_AGENT_CONFIG): Promise<AgentConfig> {
  if (!path || !isAbsolute(path)) throw new Error("BRAI_AGENT_CONFIG_ABSOLUTE_PATH_REQUIRED");
  let text: string;
  let handle;
  try {
    handle = await open(path, "r");
    if (!(await handle.stat()).isFile()) invalid();
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 1024 * 1024) invalid();
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_AGENT_CONFIG") throw error;
    throw new Error("AGENT_CONFIG_UNAVAILABLE");
  } finally { await handle?.close(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("INVALID_AGENT_CONFIG"); }
  return parseConfig(parsed);
}
