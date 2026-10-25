// ABOUTME: Запускает только принятый coordinator из переносимого release с новым instance ID на каждый процесс.
// ABOUTME: Передаёт APP-only config; отключённый или недоступный local-ai не объявляется готовым.
import { randomUUID } from 'node:crypto';
import { loadCoordinatorConfig } from '/payload/services/transcription/dist/coordinator/config.js';
import { startCoordinator } from '/payload/services/transcription/dist/coordinator/main.js';

try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TRANSCRIPTION_') &&
    !key.includes('MIGRATION') && !key.includes('OWNER_ROLE') && key !== 'TRANSCRIPTION_APP_ROLE'));
  env.TRANSCRIPTION_INSTANCE_ID = `transcription-${randomUUID()}`;
  env.TRANSCRIPTION_WORKER_ID = `${env.TRANSCRIPTION_INSTANCE_ID}-worker`;
  if (env.TRANSCRIPTION_HELPER_PGHOST !== 'supabase-db' || env.TRANSCRIPTION_HELPER_PGPORT !== '5432' ||
    env.TRANSCRIPTION_HELPER_PGDATABASE !== 'service_transcription' || env.TRANSCRIPTION_HELPER_PGUSER !== 'brai_transcription_app' ||
    env.TRANSCRIPTION_NATS_USER !== 'transcription' || env.TRANSCRIPTION_LOCAL_AI_NATS_USER !== 'transcription_local_ai') throw Error('Invalid runtime identity');
  const runtime = await startCoordinator(loadCoordinatorConfig(env));
  const status = await runtime.status();
  process.stdout.write(JSON.stringify({ metadataReady: status.metadataReady, ready: status.ready,
    localConfigured: status.localExecutor.configured, localVerified: status.localExecutor.verified, localAvailable: status.localExecutor.available }) + '\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch {
  process.stderr.write('TRANSCRIPTION_STARTUP_FAILED\n');
  process.exitCode = 1;
}
