// ABOUTME: Описывает единственную native-display границу agent v2.
// ABOUTME: История остаётся у Codex; AG-UI переносит состояние, а не второй lifecycle.
export type DisplayItem = { id: string; turnId: string; type: string; text: string; command?: string; output?: string; diff?: string; status?: string; exitCode?: number | null; phase?: string | null; truncated?: boolean; summary?: string; hasContent?: boolean; revision?: number; timestamp?: number; images?: string[]; imageCount?: number };
export type PendingRequest = { requestId: string; kind: "command-approval" | "file-change-approval" | "permissions" | "question" | "unsupported"; method: string; turnId: string; params: Record<string, any>; answered: boolean; reason?: string };
export type NativeTurn = { id: string; status: string; error?: { message: string; code?: string } };
export type ThreadMetadata = { id: string; title: string; preview: string; model: string | null; reasoningEffort?: string | null; canAcceptDirectInput: boolean | null; updatedAt: number; active?: boolean; lastMessageAt?: number; finalMessageId?: string | null; awaitingReply?: boolean };
export type PermissionMode = "ask" | "auto" | "full";
export type AgentMode = "default" | "plan" | "goal";
export type AgentGoal = { threadId: string; objective: string; status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"; timeUsedSeconds: number; tokensUsed: number; tokenBudget: number | null; createdAt: number; updatedAt: number; truncated?: boolean };
export type GoalProjection = { state: "ready" | "stale" | "unavailable"; value: AgentGoal | null };
export type PlanProgress = { state: "live" | "stale" | "unavailable"; turnId: string | null; explanation: string | null; steps: { step: string; status: "pending" | "inProgress" | "completed" }[]; truncated: boolean };
export type ModelChoice = { model: string; name: string; efforts: string[]; defaultEffort: string; inputModalities: string[]; imageLimit: number };
export type ModelCatalog = { generation: string; data: ModelChoice[]; defaultModel: string | null };
export type AgentLimits = { state: "loading" | "ready" | "stale" | "unavailable"; revision: number; observedAt: number | null; windows: { slot: "primary" | "secondary"; remainingPercent: number; windowDurationMins: number | null; resetsAt: number | null }[] };
/** Последний native запрос, включая ответ; накопленная стоимость чата сюда не входит. */
export type ContextUsage = { usedTokens: number; contextWindow: number | null };
export type NativeSnapshot = { projectId: string; threadId: string; generation: string; epoch: string; seq: number; thread: ThreadMetadata; turn: NativeTurn | null; state: string; items: DisplayItem[]; requests: PendingRequest[]; truncated: boolean; goal?: GoalProjection; planProgress?: PlanProgress; contextUsage?: ContextUsage | null };
export type EventEnvelope = { projectId: string; threadId: string; generation: string; epoch: string; seq: number; event: { type: "STATE_SNAPSHOT"; snapshot: NativeSnapshot } };
export type Action = "projects" | "status" | "models" | "threads" | "create" | "open" | "turns" | "items" | "activities" | "item" | "start" | "steer" | "interrupt" | "answer" | "archive" | "goalGet" | "goalSet" | "goalClear";
export type Command = { action: Action; agentMode?: AgentMode; objective?: string; status?: "active" | "paused"; tokenBudget?: number | null; permissionMode?: PermissionMode; model?: string; effort?: string; projectId?: string; threadId?: string; generation?: string; operationId?: string; turnId?: string; expectedTurnId?: string; requestId?: string; text?: string; images?: string[]; answer?: unknown; cursor?: string; itemId?: string; itemIds?: string[] };
export type ErrorResponse = { code: string; outcome: "not-sent" | "unknown" | "query" };
export declare const subjects: { rpc: string; event: string };
export declare const limits: { frame: number; input: number; images: number; imageBytes: number; state: number; clients: number; queue: number; threads: number; pending: number; operations: number; request: number };
export declare const commandSchema: object;
export declare function bytes(value: unknown): number;
export declare function validateCommand(value: unknown): value is Command;
export declare function validateLimits(value: unknown): value is AgentLimits;
export declare function validateEnvelope(value: unknown): value is EventEnvelope;
