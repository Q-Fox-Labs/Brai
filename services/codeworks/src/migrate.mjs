// ABOUTME: Применяет атомарные версионированные миграции собственной БД Codeworks.
// ABOUTME: Runtime получает DML без владения схемой; запуск сервиса не выполняет миграцию.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
const quote = value => '"' + value.replaceAll('"', '""') + '"';
/** Применяет миграции владельцем отдельной БД и выдаёт ограниченные права appRole. */
export async function migrate(pool, appRole) {
  if (!appRole) throw new Error('APP_ROLE_REQUIRED');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(91827422)');
    const { rows: [owner] } = await db.query('SELECT current_user AS role, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()');
    if (owner.role !== owner.owner || owner.role === appRole) throw new Error('SEPARATE_DATABASE_OWNER_REQUIRED');
    const { rows: [role] } = await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1', [appRole]);
    if (!role || Object.values(role).some(Boolean)) throw new Error('UNSAFE_APP_ROLE');
    const { rowCount } = await db.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)', [appRole]);
    if (rowCount) throw new Error('APP_ROLE_MEMBERSHIP_FORBIDDEN');
    await db.query('CREATE TABLE IF NOT EXISTS public.codeworks_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)');
    for(const version of [1,2,3]) {
      const sql=await readFile(new URL('../migrations/'+String(version).padStart(3,'0')+'.sql',import.meta.url),'utf8');
      const sha=createHash('sha256').update(sql).digest('hex');
      const applied=(await db.query('SELECT sha256 FROM public.codeworks_migrations WHERE version=$1',[version])).rows[0];
      if(applied&&applied.sha256!==sha)throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      if(!applied){await db.query(sql);await db.query('INSERT INTO public.codeworks_migrations VALUES($1,$2)',[version,sha]);}
    }
    const wrongOwner=(await db.query("SELECT 1 FROM pg_class WHERE relnamespace='codeworks'::regnamespace AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)",[owner.role])).rowCount;
    const schemaOwner=(await db.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='codeworks'")).rows[0]?.owner;
    if(wrongOwner||schemaOwner!==owner.role)throw new Error('SCHEMA_OWNER_MISMATCH');
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query(`REVOKE CREATE ON SCHEMA public FROM ${quote(appRole)}`);
    await db.query('REVOKE ALL ON SCHEMA codeworks FROM PUBLIC');
    await db.query(`REVOKE ALL ON SCHEMA codeworks FROM ${quote(appRole)}`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA codeworks FROM PUBLIC,${quote(appRole)}`);
    await db.query(`GRANT USAGE ON SCHEMA codeworks TO ${quote(appRole)}`);
    await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codeworks TO ${quote(appRole)}`);
    await db.query(`REVOKE UPDATE ON codeworks.verified_ci FROM ${quote(appRole)}`);
    await db.query(`REVOKE ALL ON public.codeworks_migrations FROM PUBLIC,${quote(appRole)}`);
    const comments = { run_id:'Точный удостоверенный GitHub Actions run.', attempt:'Номер удостоверенной попытки Actions.', policy_sha256:'Fingerprint принятой owner policy.', proof:'Однократно проверенное CI evidence; не agent report.', id:'Стабильный ID записи.', project_id:'Ссылка на собственный реестр проектов.', config:'Политика репозитория, путей, Git flow и доступа.', workspace_key:'Внешний ключ продолжения области без привязки к попытке.', element_id:'Необязательный стабильный Element ID game-core.', kind:'Вид операции или ветки.', base_ref:'Исходная ссылка Git; фиксируется при создании.', base_sha:'Неизменяемая база Git.', branch:'Зарезервированное имя ветки.', path:'Канонический путь рабочей области.', ownership_token:'Случайное доказательство владения внешними ресурсами.', preparation_state:'Последний подтверждённый этап подготовки.', writer:'Исполнитель, сессия, эпоха и active/quiesced права записи.', executor_id:'Удостоверенный транспортом исполнитель.', actor_id:'Необязательный заявленный инициатор.', workspace_id:'ID собственной рабочей области.', status:'Состояние durable операции.', step:'Последний сохранённый шаг.', request:'Исходные параметры операции.', result:'Фактический результат операции.', error:'Безопасная ошибка без инфраструктурных секретов.', created_at:'Время создания UTC.', updated_at:'Время последнего подтверждения UTC.', idempotency_key:'Ключ безопасного повтора в области проекта и исполнителя.', payload_sha256:'Хеш нормализованных параметров и имени операции.', operation_id:'ID первоначальной durable операции.', session_id:'Внешний ID сессии; не удостоверяет исполнителя.', move_id:'Отдельная ссылка на Move game-core.', attempt_id:'Отдельная ссылка на attempt game-core.', writer_epoch:'Версия права записи при подключении.', target:'Запрошенный контур выпуска.', requested_sha:'Точный commit запрошенного выпуска.', state:'Подтверждённое состояние запроса выпуска.', details:'Закреплённые Git/GitHub намерения и фактические результаты шагов.', commit_sha:'Точный commit проверенной установленной версии.', evidence_url:'Ссылка на доверенный отчёт rollout и проверки окружения.' };
    const columns = (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='codeworks'")).rows;
    for (const column of columns) {
      if (!comments[column.column_name]) throw new Error('COLUMN_COMMENT_REQUIRED');
      await db.query(`COMMENT ON COLUMN codeworks.${quote(column.table_name)}.${quote(column.column_name)} IS '${comments[column.column_name].replaceAll("'", "''")}'`);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.CODEWORKS_OWNER_DATABASE_URL });
  try { if (!process.env.CODEWORKS_OWNER_DATABASE_URL) throw new Error('OWNER_DATABASE_URL_REQUIRED'); await migrate(pool, process.env.CODEWORKS_APP_ROLE); console.log('codeworks migration complete'); }
  catch (error) { console.error(error.message?.startsWith('MIGRATION_') ? error.message : 'codeworks migration failed'); process.exitCode=1; }
  finally { await pool.end(); }
}
