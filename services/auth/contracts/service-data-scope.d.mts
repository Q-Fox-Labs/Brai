// ABOUTME: Публикует типы server-derived namespace личных сервисов.
// ABOUTME: Вызывающий код передаёт только проверенный profileId.
export const SERVICE_DATA_EPOCH: 'brai-personal-v1';
export const SERVICE_DATA_PREFIX: string;
export function serviceDataScope(profileId: string): string;
export function isServiceDataScope(value: unknown): boolean;
