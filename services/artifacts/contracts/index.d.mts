// ABOUTME: Объявляет типы единственного публичного контракта artifacts.
// ABOUTME: Payload соответствует Draft-07 схемам рядом с этим файлом.
export type ArtifactKind = "original" | "copy";
export type ArtifactStatus = "pending" | "ready" | "deleting" | "deleted" | "failed";
export type Artifact = {
  artifactId: string; ownerId: string; requestId: string; kind: ArtifactKind; status: ArtifactStatus;
  title: string; filename: string; extension: string; mimeType: string; source: string;
  geotag?: Record<string, unknown>; materialCreatedAt?: string; details?: Record<string, unknown>;
  sizeBytes: number | null; sha256: string | null; internalUrl?: string; createdAt: string; updatedAt: string; deletedAt?: string;
};
export type ReferenceState = "pending" | "unknown" | "confirmed" | "not-sent";
export type ReferenceScope = { ownerId: string; projectId: string; threadId: string; operationId: string };
export type ReferenceQueryScope = { ownerId: string; projectId: string; threadId: string };
export type ReferenceAttachment = { originalArtifactId: string; modelArtifactId: string };
export type ArtifactReference = {
  scope: ReferenceScope; clientUserMessageId: string; commandHash: string; attachments: ReferenceAttachment[];
  state: ReferenceState; turnId?: string; itemId?: string; createdAt: string; updatedAt: string;
};
export type UploadResponseHeaders = {
  "X-Artifact-Id": string; "X-Artifact-State": "ready"; "X-Artifact-Size": string;
  "X-Artifact-SHA256": string; Location: string; [header: string]: string;
};
export type Subject = (typeof subjects)[keyof typeof subjects];
export type SchemaDefinition = Record<string, unknown>;
export declare const serviceName: "brai_artifacts";
export declare const subjects: {
  readonly prepare: "brai.artifacts.v1.prepare"; readonly get: "brai.artifacts.v1.get";
  readonly update: "brai.artifacts.v1.update"; readonly list: "brai.artifacts.v1.list";
  readonly stats: "brai.artifacts.v1.stats"; readonly delete: "brai.artifacts.v1.delete";
  readonly relationAdd: "brai.artifacts.v1.relation.add"; readonly relationRemove: "brai.artifacts.v1.relation.remove";
  readonly relationList: "brai.artifacts.v1.relation.list"; readonly referenceReserve: "brai.artifacts.v1.reference.reserve";
  readonly referenceGet: "brai.artifacts.v1.reference.get"; readonly referenceConfirm: "brai.artifacts.v1.reference.confirm";
  readonly referenceList: "brai.artifacts.v1.reference.list"; readonly referenceUpdateState: "brai.artifacts.v1.reference.update-state";
  readonly linkCreate: "brai.artifacts.v1.link.create"; readonly linkRevoke: "brai.artifacts.v1.link.revoke";
};
export declare const schemas: { $schema: string; $id: string; title: string; type: string; definitions: Record<string, SchemaDefinition> };
/** Проверяет запрос по схеме соответствующего subject. */
export declare function validateRequest(subject: string, value: unknown): boolean;
/** Проверяет успешный ответ по схеме subject; ошибки передаются NATS заголовками. */
export declare function validateResponse(subject: string, value: unknown): boolean;
