// ABOUTME: Реализует транзакционное хранилище каталога local-ai в PostgreSQL.
// ABOUTME: Runtime делает только DML; каталог и установки сохраняются независимо от истории.
import type { Pool, PoolClient } from 'pg';
import { LocalAiError } from '../errors.js';
import { validateSchema } from '../../contracts/index.mjs';
import type { LocalAiStore } from '../ports.js';
import type {
  CatalogFilter, InstallationOperation, InstallationRecord,
  LocalAiTx, ModelRecord, ModelSettings,
} from '../types.js';

export type PostgresStoreOptions = { queryTimeoutMs: number };
export type PostgresLocalAiStore = LocalAiStore;

const settingKeys = ['idleUnloadSeconds'];
const json = (value: unknown): string => JSON.stringify(value);
const hasExactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
};
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value as Record<string, unknown>, required, optional)) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_STORAGE_RECORD');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 255): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T([0-2]\d):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h);
  const days = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  return year >= 1 && day >= 1 && day <= days && hour <= 23 && Number.isFinite(Date.parse(value));
}
function validateFileList(value: unknown): void {
  if (!Array.isArray(value)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_FILE_MANIFEST');
  const paths = new Set<string>();
  for (const raw of value) {
    const file = record(raw, ['path', 'sizeBytes', 'sha256']);
    const path = file.path;
    if (!text(path, 4096) || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(path)
      || !Number.isSafeInteger(file.sizeBytes) || (file.sizeBytes as number) < 1 || typeof file.sha256 !== 'string' || !/^[\da-f]{64}$/i.test(file.sha256)) {
      throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_FILE_MANIFEST');
    }
    paths.add(path);
  }
}
function validateInstallation(value: InstallationRecord): void {
  const item = record(value, ['modelId', 'revision', 'profileId', 'directory', 'files', 'installedAt']);
  if (!text(item.modelId) || !text(item.revision) || !text(item.profileId) || !text(item.directory, 4096)
    || !item.directory.startsWith('/') || item.directory.split('/').includes('..') || !timestamp(item.installedAt)) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION');
  }
  validateFileList(item.files);
}
function validateOperation(value: InstallationOperation): void {
  if (!validateSchema('InstallOperation', value)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION_OPERATION');
}
function safeError(error: unknown): LocalAiError {
  if (error instanceof LocalAiError) return error;
  const code = (error as { code?: string } | null)?.code ?? '';
  if (code.startsWith('08') || code.startsWith('ECONN') || ['57P01', '57P02', '57P03', '53300', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(code)) {
    return new LocalAiError('DEPENDENCY_UNAVAILABLE', 'STORAGE_UNAVAILABLE', true);
  }
  if (['22001', '22P02', '23502', '23503', '23514'].includes(code)) return new LocalAiError('INVALID_ARGUMENT', 'INVALID_STORAGE_RECORD');
  if (code === '23505') return new LocalAiError('REVISION_CONFLICT', 'STORAGE_CONFLICT');
  if (code === '57014') return new LocalAiError('DEPENDENCY_UNAVAILABLE', 'STORAGE_QUERY_TIMEOUT', true);
  return new LocalAiError('INTERNAL', 'STORAGE_OPERATION_FAILED');
}
function localTime(date: Date): string { return date.toISOString(); }
function checkPositiveInteger(value: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_STORAGE_LIMIT');
}
/** Подключает готовый пул; вызывающий код владеет его созданием и закрытием. */
export function createPostgresStore(pool: Pool, options: PostgresStoreOptions): PostgresLocalAiStore {
  checkPositiveInteger(options.queryTimeoutMs, 2_147_483_647);

  async function withClient<T>(run: (client: PoolClient, discard: () => void) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let broken = false;
    const failConnection = () => { broken = true; };
    try {
      client = await pool.connect();
      client.on('error', failConnection);
      await client.query({
        text: "SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false)",
        values: [`${options.queryTimeoutMs}ms`],
      });
      return await run(client, failConnection);
    } catch (error) {
      throw safeError(error);
    } finally {
      if (client) {
        client.removeListener('error', failConnection);
        client.release(broken);
      }
    }
  }

  async function transaction<T>(run: (tx: LocalAiTx, query: (sql: string, values?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
    return withClient(async (client, discard) => {
      let begun = false;
      try {
        await client.query('BEGIN'); begun = true;
        const query = (sql: string, values: unknown[] = []) => client.query(sql, values);
        const result = await run(makeTx(query), query);
        await client.query('COMMIT'); begun = false;
        return result;
      } catch (error) {
        if (begun) {
          try { await client.query('ROLLBACK'); } catch { discard(); }
        }
        throw safeError(error);
      }
    });
  }

  function makeTx(query: (sql: string, values?: unknown[]) => Promise<any>): LocalAiTx {
    return {
      models: {
        async list(filter: CatalogFilter): Promise<ModelRecord[]> {
          const f = record(filter, [], ['modelId', 'operation', 'inputKind', 'outputKind', 'language', 'installed']);
          const clauses: string[] = [];
          const values: unknown[] = [];
          const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
          if (f.modelId !== undefined) { if (!text(f.modelId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_FILTER'); add('m.model_id=?', f.modelId); }
          if (f.operation !== undefined) add("m.operations @> to_jsonb(ARRAY[?::text])", f.operation);
          if (f.inputKind !== undefined) add("m.input_kinds @> to_jsonb(ARRAY[?::text])", f.inputKind);
          if (f.outputKind !== undefined) add("m.output_kinds @> to_jsonb(ARRAY[?::text])", f.outputKind);
          if (f.language !== undefined) { if (!text(f.language, 128)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_FILTER'); add('m.languages @> to_jsonb(ARRAY[?::text])', f.language); }
          if (f.installed !== undefined) {
            if (typeof f.installed !== 'boolean') throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_FILTER');
            clauses.push(f.installed ? 'EXISTS (SELECT 1 FROM local_ai.installations i WHERE i.model_id=m.model_id AND i.revision=m.revision)' : 'NOT EXISTS (SELECT 1 FROM local_ai.installations i WHERE i.model_id=m.model_id AND i.revision=m.revision)');
          }
          const { rows } = await query(`SELECT m.document FROM local_ai.models m ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY m.model_id`, values);
          return rows.map((row: { document: ModelRecord }) => row.document);
        },
        async get(modelId) {
          if (!text(modelId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_ID');
          const { rows } = await query('SELECT document FROM local_ai.models WHERE model_id=$1', [modelId]);
          return rows[0]?.document ?? null;
        },
        async put(value) {
          if (!validateSchema('ModelRecord', value)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_RECORD');
          await query(`INSERT INTO local_ai.models(model_id,revision,supported,operations,input_kinds,output_kinds,languages,document)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)
            ON CONFLICT(model_id) DO UPDATE SET revision=EXCLUDED.revision,supported=EXCLUDED.supported,operations=EXCLUDED.operations,
              input_kinds=EXCLUDED.input_kinds,output_kinds=EXCLUDED.output_kinds,languages=EXCLUDED.languages,document=EXCLUDED.document`,
          [value.modelId, value.revision, value.supported, json(value.operations), json(value.inputKinds), json(value.outputKinds), json(value.languages), json(value)]);
        },
        async remove(modelId) {
          const result = await query('DELETE FROM local_ai.models WHERE model_id=$1', [modelId]);
          if (!result.rowCount) throw new LocalAiError('MODEL_NOT_FOUND', 'MODEL_NOT_FOUND');
        },
      },
      installations: {
        async list(filter) {
          const f = record(filter, [], ['modelId', 'installed']);
          if (f.installed !== undefined && typeof f.installed !== 'boolean') throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION_FILTER');
          if (f.installed === false) return [];
          if (f.modelId !== undefined && !text(f.modelId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION_FILTER');
          const { rows } = await query(`SELECT model_id,revision,profile_id,directory,files,installed_at FROM local_ai.installations ${f.modelId === undefined ? '' : 'WHERE model_id=$1'} ORDER BY model_id,revision`, f.modelId === undefined ? [] : [f.modelId]);
          return rows.map((row: any) => ({ modelId: row.model_id, revision: row.revision, profileId: row.profile_id, directory: row.directory, files: row.files, installedAt: localTime(new Date(row.installed_at)) }));
        },
        async get(modelId, revision) {
          if (!text(modelId) || !text(revision)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION_SELECTOR');
          const { rows } = await query('SELECT model_id,revision,profile_id,directory,files,installed_at FROM local_ai.installations WHERE model_id=$1 AND revision=$2', [modelId, revision]);
          const row = rows[0];
          return row ? { modelId: row.model_id, revision: row.revision, profileId: row.profile_id, directory: row.directory, files: row.files, installedAt: localTime(new Date(row.installed_at)) } : null;
        },
        async put(value) {
          validateInstallation(value);
          const result = await query(`INSERT INTO local_ai.installations(model_id,revision,profile_id,directory,files,installed_at)
            VALUES($1,$2,$3,$4,$5::jsonb,$6::timestamptz) ON CONFLICT(model_id,revision) DO NOTHING`,
          [value.modelId, value.revision, value.profileId, value.directory, json(value.files), value.installedAt]);
          if (result.rowCount) return;
          const old = await query('SELECT profile_id,directory,files FROM local_ai.installations WHERE model_id=$1 AND revision=$2', [value.modelId, value.revision]);
          const row = old.rows[0];
          const savedFiles = row?.files as Array<{ path: string; sizeBytes: number; sha256: string }> | undefined;
          const sameFiles = savedFiles?.length === value.files.length && savedFiles.every((file, index) => {
            const expected = value.files[index];
            return file.path === expected.path && file.sizeBytes === expected.sizeBytes && file.sha256 === expected.sha256;
          });
          if (!row || row.profile_id !== value.profileId || row.directory !== value.directory || !sameFiles) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_REVISION_CONFLICT');
        },
        async remove(modelId, revision) {
          const result = await query('DELETE FROM local_ai.installations WHERE model_id=$1 AND revision=$2', [modelId, revision]);
          if (!result.rowCount) throw new LocalAiError('MODEL_NOT_INSTALLED', 'MODEL_NOT_INSTALLED');
        },
      },
      installationOperations: {
        async get(operationId, ownerId) {
          if (!text(operationId) || !text(ownerId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_OPERATION_SELECTOR');
          const { rows } = await query('SELECT record FROM local_ai.installation_operations WHERE operation_id=$1 AND owner_id=$2', [operationId, ownerId]);
          return rows[0]?.record ?? null;
        },
        async put(value) {
          validateOperation(value);
          const result = await query(`INSERT INTO local_ai.installation_operations(operation_id,owner_id,model_id,record,created_at,updated_at)
            VALUES($1,$2,$3,$4::jsonb,$5::timestamptz,$6::timestamptz)
            ON CONFLICT(operation_id,owner_id) DO UPDATE SET record=EXCLUDED.record,updated_at=EXCLUDED.updated_at
            WHERE local_ai.installation_operations.model_id=EXCLUDED.model_id
              AND local_ai.installation_operations.record->>'revision'=EXCLUDED.record->>'revision'
              AND local_ai.installation_operations.record->>'profileId' IS NOT DISTINCT FROM EXCLUDED.record->>'profileId'
              AND local_ai.installation_operations.record->>'createdAt'=EXCLUDED.record->>'createdAt'
            RETURNING operation_id`,
          [value.operationId, value.ownerId, value.modelId, json(value), value.createdAt, value.updatedAt]);
          if (!result.rowCount) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_OPERATION_ID_CONFLICT');
        },
      },
      settings: {
        async get(modelId): Promise<ModelSettings | null> {
          if (!text(modelId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_ID');
          const { rows } = await query('SELECT idle_unload_seconds FROM local_ai.settings WHERE model_id=$1', [modelId]);
          return rows[0] ? { idleUnloadSeconds: rows[0].idle_unload_seconds } : null;
        },
        async put(modelId, value) {
          if (!text(modelId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_ID');
          const settings = record(value, settingKeys);
          if (!(settings.idleUnloadSeconds === null || Number.isSafeInteger(settings.idleUnloadSeconds) && (settings.idleUnloadSeconds as number) > 0)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SETTINGS');
          await query(`INSERT INTO local_ai.settings(model_id,idle_unload_seconds) VALUES($1,$2)
            ON CONFLICT(model_id) DO UPDATE SET idle_unload_seconds=EXCLUDED.idle_unload_seconds,updated_at=clock_timestamp()`,
          [modelId, settings.idleUnloadSeconds]);
        },
      },

    };
  }

  return {
    transaction: run => transaction(async tx => run(tx)),
    async recoverInterrupted() {
      return transaction(async (_tx, query) => {
        const { rows } = await query("SELECT record FROM local_ai.installation_operations WHERE record->>'status' IN ('accepted','running') FOR UPDATE");
        for (const row of rows) {
          const operation = row.record as InstallationOperation;
          const recovered: InstallationOperation = { ...operation, status: 'unknown', phase: 'failed', errorCode: 'INTERNAL', updatedAt: localTime(new Date()) };
          await query(`UPDATE local_ai.installation_operations SET record=$3::jsonb,updated_at=$4::timestamptz
            WHERE operation_id=$1 AND owner_id=$2`, [operation.operationId, operation.ownerId, json(recovered), recovered.updatedAt]);
        }
        return rows.length;
      });
    },
  };
}
