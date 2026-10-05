// ABOUTME: Описывает TypeScript API owner contract validator.
// ABOUTME: Метаданные истории и DTO проверяются схемами-владельцами.
import type { LocalAiHistoryMetadataEvent } from '../src/types.js';

export const serviceName: 'brai_local_ai';
export const subjects: Readonly<Record<string, string>>;
export const schemas: Readonly<Record<'messages' | 'facts', Record<string, unknown>>>;
export function validateRequest(subject: string, value: unknown): boolean;
export function validateResponse(subject: string, value: unknown): boolean;
export function validateSchema(definitionName: string, value: unknown): boolean;
export function validateMetadataEvent(value: unknown): value is LocalAiHistoryMetadataEvent;
export function validateError(value: unknown): boolean;
