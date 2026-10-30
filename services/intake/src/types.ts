// ABOUTME: Определяет события, пакеты и необходимые внешние операции Приёма.
// ABOUTME: Не зависит от SQL, транспорта или Temporal.
export type Data = Record<string, unknown>;
export type EventType = 'message.incoming' | 'message.outgoing' | 'event.recorded' | 'operation.result' | 'processing.resume';
export interface Event { version: 1; eventId: string; source: string; type: EventType; occurredAt: string; correlationId: string; causationId: string | null; data: Data; }
export interface Binding { ownerId: string; types: EventType[]; recipients: string[]; read: boolean; resume: boolean; fileBaseUrl?: string; }
export interface Attachment { artifactId?: string; fileId?: string; filename: string; mimeType: string; caption?: string; }
export interface Message extends Data { materialId: string; revision: number; conversationId: string; replyToMessageId: string | null; author: { kind: 'human' | 'agent'; id: string; name?:string|null; username?:string|null; photoArtifactId?:string|null }; sourceRef: Data; text: string | null; attachments: Attachment[]; }
export type JobKind = 'hermes' | 'understand' | 'memory' | 'deliver';
export type PortName = 'channel' | 'contact' | 'inbox' | JobKind;
export interface PortConfig { subject: string; resultSource?: string; }
export interface Job { id: string; kind: JobKind; attempt: number; expectedSource: string; state: 'pending' | 'succeeded' | 'failed' | 'unknown'; result?: Data; resultVersion?: number; notifiedVersion?: number; }
export interface Packet {
 id: string; ownerId: string; source: string; eventId: string; inputHash: string; original: Event; receiptId: string | null; receivedAt: string;
 mode: 'temporal' | 'jetstream'; scenario: 'incoming.v1' | 'outgoing.v1' | 'forward.v1';
 state: 'registered' | 'processing' | 'forwarded' | 'completed' | 'needs_attention';
 workflowId: string | null; context?: Data; contact?: Data; prepared?: Data; inboxRef?: Data;
 jobs: Record<string, Job>; attempts: Partial<Record<JobKind, number>>; dispatch: Record<string, boolean>;
 attention?: Record<string,{reason:string;resumeVersion:number}>; resumeVersion: number; resumeNotifiedVersion?: number; reason: string | null; completedAt?: string;
}
export interface Delivery { stream: string; sequence: number; source: string; receivedAt?: string; }
export interface Reject { delivery: Delivery; ownerId: string | null; eventId: string | null; hash: string; code: string; }
export interface ControlIdentity { source: string; eventId: string; inputHash: string; ownerId: string; }
export interface Store {
 register(event: Event, binding: Binding, hash: string, receivedAt?: string): Promise<Packet>;
 get(id: string): Promise<Packet | null>; find(source: string, eventId: string): Promise<Packet | null>;
 update(id: string, change: (packet: Packet) => void, control?: ControlIdentity): Promise<Packet>; reject(rejection: Reject): Promise<void>; rejection(source: string, sequence: number): Promise<Reject | null>; ready(): Promise<void>;
}
export interface Ports {
 call(name: PortName, packet: Packet, operationId: string, extra?: Data): Promise<Data>;
 prepareFiles(packet: Packet, signal?: AbortSignal): Promise<Data[]>; publish(subject: string, event: Event, id: string, ownerId: string): Promise<void>;
 startWorkflow(packet: Packet): Promise<void>; signalWorkflow(packet: Packet): Promise<void>;
 history(packet: Packet, phase: 'receive' | 'complete'): Promise<void>;
}
export class Fault extends Error {
 constructor(public code: string, public retryable = false) { super(code); this.name = 'IntakeFault'; }
}
