// ABOUTME: Описывает единственную native-display границу agent v2.
// ABOUTME: История остаётся у Codex; AG-UI переносит состояние, а не второй lifecycle.
export type DisplayItem = { id: string; turnId: string; type: string; text: string; command?: string; output?: string; diff?: string; status?: string; exitCode?: number | null; phase?: string | null; truncated?: boolean; summary?: string; revision?: number; timestamp?: number };
export type PendingRequest = { requestId: string; kind: "command-approval" | "file-change-approval" | "permissions" | "question" | "unsupported"; method: string; turnId: string; params: Record<string, any>; answered: boolean; reason?: string };
export type ThreadMetadata = { id: string; title: string; preview: string; model: string | null; reasoningEffort?: string | null; canAcceptDirectInput: boolean | null; updatedAt: number; active?: boolean; lastMessageAt?: number };
export type PermissionMode = "ask" | "auto" | "full";
export type ModelChoice = { model: string; name: string; efforts: string[]; defaultEffort: string };
export type ModelCatalog = { generation: string; data: ModelChoice[]; defaultModel: string | null };
export type NativeSnapshot = { projectId: string; threadId: string; generation: string; epoch: string; seq: number; thread: ThreadMetadata; turn: { id: string; status: string } | null; state: string; items: DisplayItem[]; requests: PendingRequest[]; truncated: boolean };
export type EventEnvelope = { projectId: string; threadId: string; generation: string; epoch: string; seq: number; event: { type: "STATE_SNAPSHOT"; snapshot: NativeSnapshot } };
export type Action = "projects" | "status" | "models" | "threads" | "create" | "open" | "turns" | "items" | "activities" | "item" | "start" | "steer" | "interrupt" | "answer";
export type Command = { action: Action; permissionMode?: PermissionMode; model?: string; effort?: string; projectId?: string; threadId?: string; generation?: string; operationId?: string; turnId?: string; expectedTurnId?: string; requestId?: string; text?: string; answer?: unknown; cursor?: string; itemId?: string; itemIds?: string[] };
export type ErrorResponse = { code: string; outcome: "not-sent" | "unknown" | "query" };
export declare const subjects: { rpc: string; event: string };
export declare const limits: { frame: number; input: number; state: number; clients: number; queue: number; threads: number; pending: number; operations: number; request: number };
export declare const commandSchema: object;
export declare function bytes(value: unknown): number;
export declare function validateCommand(value: unknown): value is Command;
export declare function validateEnvelope(value: unknown): value is EventEnvelope;
