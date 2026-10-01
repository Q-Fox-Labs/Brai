// ABOUTME: Объявляет состояние, которое страница читает у клиента agent.
// ABOUTME: DTO транспорта остаются во владении @brai/agent/contracts.
import type {
  HistoryItem,
  CodexMessagePhase,
  PendingRequest,
  Project,
  StatusResponse,
  ThreadMetadata,
  ThreadSnapshot,
} from "@brai/agent/contracts";
import type { ActivityDeltaEvent, ActivitySnapshotEvent, Message, SubagentErrorEvent, SubagentFinishedEvent, SubagentStartedEvent } from "@ag-ui/core";

export type AgentStatus = ThreadSnapshot["state"];
export type MutationState = "idle" | "pending" | "accepted" | "unknown" | "failed";

export type AgentClientState = {
  projects: Project[];
  status: StatusResponse | null;
  selectedProjectId: string | null;
  threads: ThreadMetadata[];
  threadsCursor: string | null;
  selectedThreadId: string | null;
  messages: Message[];
  pendingRequests: PendingRequest[];
  traceItems: ThreadSnapshot["traceItems"];
  activityEvents: (ActivitySnapshotEvent | ActivityDeltaEvent)[];
  subagentEvents: (SubagentStartedEvent | SubagentFinishedEvent | SubagentErrorEvent)[];
  messagePhases: Record<string, CodexMessagePhase | null>;
  pendingMessagePhases: Record<string, CodexMessagePhase | null>;
  threadStatus: AgentStatus | null;
  generation: string | null;
  activeTurnId: string | null;
  streamEpoch: string | null;
  lastSeq: number | null;
  truncation: ThreadSnapshot["truncation"] | null;
  historyItems: HistoryItem[];
  historyCursor: string | null;
  historyTruncated: boolean;
  historyError: string | null;
  connection: "idle" | "connecting" | "connected" | "connection-lost" | "unauthorized";
  readError: string | null;
  draft: string;
  mutation: MutationState;
  mutationError: string | null;
  resyncing: boolean;
};

/** Создаёт пустое состояние для одного экземпляра браузерного клиента. */
export function initialAgentClientState(): AgentClientState {
  return {
    projects: [], status: null, selectedProjectId: null, threads: [], threadsCursor: null,
    selectedThreadId: null, messages: [], pendingRequests: [], traceItems: [], activityEvents: [], subagentEvents: [], messagePhases: {}, pendingMessagePhases: {}, threadStatus: null,
    generation: null, activeTurnId: null, streamEpoch: null, lastSeq: null, truncation: null,
    historyItems: [], historyCursor: null, historyTruncated: false, historyError: null,
    connection: "idle", readError: null, draft: "", mutation: "idle", mutationError: null, resyncing: false,
  };
}
