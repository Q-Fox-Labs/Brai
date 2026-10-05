// ABOUTME: Публикует шесть metadata операций координатора через официальный NATS Services API.
// ABOUTME: result.get и текст отсутствуют; ошибки/stats содержат только закрытые безопасные коды.
import type { NatsConnection, ServiceMsg } from 'nats';
import { methodMap } from '#transcription-contracts';
import { encodeBoundedJson } from '../../runtime/stdio-rpc.js';
import { errorStatus, safeError, type PublicGateway } from './boundary.js';

/** Регистрирует Services PING/INFO/STATS и queue endpoints; connection принадлежит внешней сборке. */
export async function startNatsTransport(nc: NatsConnection, gateway: PublicGateway, limits: { requestBytes: number; responseBytes: number }) {
  for (const value of [limits.requestBytes, limits.responseBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid transcription NATS limits');
  }
  const service = await nc.services.add({ name: 'brai_transcription', version: '1.0.0',
    description: 'Brai transcription metadata', queue: 'brai_transcription' });
  const tasks = new Set<Promise<void>>();
  const respondError = (msg: ServiceMsg, error: unknown) => {
    const failure = safeError(error);
    msg.respondError(errorStatus(failure.errorCode), failure.errorCode, encodeBoundedJson(failure, limits.responseBytes));
  };
  for (const method of Object.keys(methodMap.public).filter((method) => method !== 'result.get')) {
    service.addEndpoint(method.replaceAll('.', '_'), {
      subject: `brai.transcription.v1.${method}`, queue: 'brai_transcription',
      handler: (error, msg) => {
        const task = gateway.withCapacity(async () => {
          if (error) throw { errorCode: 'DEPENDENCY_UNAVAILABLE' };
          const principal = gateway.authenticate(msg.headers?.get('Authorization'));
          if (msg.data.byteLength > limits.requestBytes) throw { errorCode: 'INPUT_TOO_LARGE' };
          let input: unknown;
          try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(msg.data)); }
          catch { throw { errorCode: 'INVALID_ARGUMENT' }; }
          const result = await gateway.invoke(method, input, principal);
          let bytes: Buffer;
          try { bytes = encodeBoundedJson(result, limits.responseBytes); }
          catch { throw { errorCode: 'RESULT_TOO_LARGE' }; }
          msg.respond(bytes);
        }).catch((failure) => respondError(msg, failure)).catch(() => {
          // Закрытый канал означает потерю ответа; payload и сырая ошибка не журналируются.
        }).finally(() => tasks.delete(task));
        tasks.add(task);
      },
    });
  }
  await nc.flush();
  return { service, close: () => service.stop(), settled: () => Promise.allSettled([...tasks]).then(() => undefined) };
}
