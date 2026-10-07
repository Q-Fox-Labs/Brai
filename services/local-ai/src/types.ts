// ABOUTME: Определяет DTO и внутренние записи ядра local-ai.
// ABOUTME: Локальные пути принадлежат установке и никогда не попадают в wire DTO.
export type OperationKind = 'embed' | 'transcribe';
export type InputKind = 'text' | 'audio_artifact';
export type OutputKind = 'vector' | 'transcription';
export type InvocationPurpose = 'query' | 'document' | 'symmetric';
export type ServiceErrorCode =
  | 'INVALID_ARGUMENT' | 'MODEL_NOT_FOUND' | 'MODEL_NOT_INSTALLED' | 'UNSUPPORTED_OPERATION'
  | 'MODEL_IN_USE' | 'INPUT_TOO_LARGE' | 'RESULT_TOO_LARGE' | 'BUSY' | 'MODEL_LOAD_FAILED'
  | 'ENGINE_UNAVAILABLE' | 'DEADLINE_EXCEEDED' | 'CANCELLED' | 'ARTIFACT_NOT_AVAILABLE'
  | 'DEPENDENCY_UNAVAILABLE' | 'INSTALLATION_FAILED' | 'REVISION_CONFLICT' | 'NOT_SUPPORTED' | 'INTERNAL';
export type OperationContext = { ownerId: string; operationId: string; deadlineAt: string; signal: AbortSignal; deadlineManaged?: true };
export type ModelSelector = { modelId: string; revision: string; profileId: string };
export type ModelFile = { path: string; sizeBytes: number; sha256: string };
export type RuntimeState = 'unloaded' | 'loading' | 'ready' | 'unloading' | 'error';
export type CatalogFilter = {
  modelId?: string; operation?: OperationKind; inputKind?: InputKind; outputKind?: OutputKind; language?: string; installed?: boolean;
};
export type ModelFilter = CatalogFilter & { ready?: boolean };
export type ModelParameters = {
  embed: { purpose: InvocationPurpose[] } | null;
  transcribe: Record<string, never> | null;
};
export type HardwareRequirements = { cpuArchitectures: string[]; minMemoryBytes: number | null; accelerator: string | null };
export type ProfileLimits = {
  maxInputBytes: number | null; maxAudioSeconds: number | null; maxItems: number | null;
  maxResultBytes: number | null; vectorDimensions: number | null;
};
export type ModelRecord = {
  modelId: string; name: string; description: string; source: string; license: string | null;
  revision: string; profileId: string | null; supported: boolean; operations: OperationKind[];
  languages: string[]; inputKinds: InputKind[]; outputKinds: OutputKind[]; files: ModelFile[];
  hardwareRequirements: HardwareRequirements; limits: ProfileLimits; parameters: ModelParameters;
};
export type ModelCard = ModelRecord & {
  installationState: 'available' | 'not_installed' | 'installed' | 'unsupported';
  runtimeState: RuntimeState | null;
};
export type ModelSettings = { idleUnloadSeconds: number | null };
export type InstallationRecord = {
  modelId: string; revision: string; profileId: string; directory: string; files: ModelFile[]; installedAt: string;
};
export type InstallationOperation = {
  operationId: string; ownerId: string; modelId: string; revision: string; profileId: string;
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  phase: 'queued' | 'downloading' | 'verifying' | 'publishing' | 'completed' | 'failed' | 'cancelled';
  progressPercent: number | null; errorCode: ServiceErrorCode | null; createdAt: string; updatedAt: string;
};
export type LocalAiHistoryMetadataEvent = {
  id: string; type_id: 103 | 203 | 204 | 301 | 902 | 1201 | 1202 | 1301; occurred_at: string;
  actor_id: string | null; scope_type: 'user' | 'system'; scope_id: string;
  object_type: 'model' | 'installation' | 'operation'; object_id: string;
  data: {
    operation: 'invoke' | 'install' | 'configure' | 'load' | 'unload' | 'remove';
    modelId: string; outcome: 'succeeded' | 'failed' | 'cancelled';
    revision?: string | null; profileId?: string | null; operationId?: string; requestId?: string;
    durationMs?: number;
    errorCode?: ServiceErrorCode;
  };
};
export interface LocalAiTx {
  models: {
    list(filter: CatalogFilter): Promise<ModelRecord[]>;
    get(modelId: string): Promise<ModelRecord | null>;
    put(record: ModelRecord): Promise<void>;
    remove(modelId: string): Promise<void>;
  };
  installations: {
    list(filter: { modelId?: string; installed?: boolean }): Promise<InstallationRecord[]>;
    get(modelId: string, revision: string): Promise<InstallationRecord | null>;
    put(record: InstallationRecord): Promise<void>;
    remove(modelId: string, revision: string): Promise<void>;
  };
  installationOperations: {
    get(operationId: string, ownerId: string): Promise<InstallationOperation | null>;
    put(value: InstallationOperation): Promise<void>;
  };
  settings: {
    get(modelId: string): Promise<ModelSettings | null>;
    put(modelId: string, value: ModelSettings): Promise<void>;
  };

}
export type ResolvedModel = { model: ModelSelector; installation: Readonly<InstallationRecord> };
export type EmbedInput = { model: ModelSelector; texts: readonly string[]; purpose: InvocationPurpose };
export type EmbedOutput = { vectors: readonly (readonly number[])[] };
export type TranscribeInput = { model: ModelSelector; audioPath: string };
export type TranscribeOutput = { text: string; segments?: readonly { startSeconds: number; endSeconds: number; text: string }[] };
