// ABOUTME: Выводит отдельный namespace личных сервисов из проверенного профиля Auth.
// ABOUTME: Канонический userId и владелец Artifacts не меняются; старые события не переназначаются.
import { createHash } from 'node:crypto';

export const SERVICE_DATA_EPOCH = 'brai-personal-v1';
export const SERVICE_DATA_PREFIX = SERVICE_DATA_EPOCH + ':';
/** @param {string} profileId */
export function serviceDataScope(profileId) {
 if (typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId)) throw new Error('PROFILE_REQUIRED');
 return SERVICE_DATA_PREFIX + createHash('sha256').update(JSON.stringify([SERVICE_DATA_EPOCH, profileId])).digest('hex');
}
/** @param {unknown} value */
export function isServiceDataScope(value) {
 return typeof value === 'string' && /^brai-personal-v1:[a-f0-9]{64}$/.test(value);
}
