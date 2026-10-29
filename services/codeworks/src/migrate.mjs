// ABOUTME: Применяет атомарные версионированные миграции собственной БД Codeworks.
// ABOUTME: Runtime получает DML без владения схемой; запуск сервиса не выполняет миграцию.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
const quote = value => '"' + value.replaceAll('"', '""') + '"';
/** Применяет миграции владельцем отдельной БД и выдаёт ограниченные права appRole. */
export async function migrate(pool, appRole, verifierRole) {
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
    for(const version of [1,2,3,4,5,6,7,8,9,10,11,12,13]) {
      const sql=await readFile(new URL('../migrations/'+String(version).padStart(3,'0')+'.sql',import.meta.url),'utf8');
      const sha=createHash('sha256').update(sql).digest('hex');
      const applied=(await db.query('SELECT sha256 FROM public.codeworks_migrations WHERE version=$1',[version])).rows[0];
      if(applied&&applied.sha256!==sha)throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      if(!applied){await db.query(sql);await db.query('INSERT INTO public.codeworks_migrations VALUES($1,$2)',[version,sha]);}
    }
    const wrongOwner=(await db.query("SELECT 1 FROM pg_class WHERE relnamespace='codeworks'::regnamespace AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)",[owner.role])).rowCount;
    const schemaOwner=(await db.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='codeworks'")).rows[0]?.owner;
    if(wrongOwner||schemaOwner!==owner.role)throw new Error('SCHEMA_OWNER_MISMATCH');
    const helper=(await db.query("SELECT pg_get_userbyid(proowner) AS owner,prosecdef,proconfig @> ARRAY['search_path=pg_catalog'] AS safe_path FROM pg_proc WHERE oid=to_regprocedure('codeworks.lock_publication_evidence(text,uuid,uuid)')")).rows[0];
    if(!helper||helper.owner!==owner.role||helper.prosecdef!==true||helper.safe_path!==true)throw new Error('PUBLICATION_LOCK_HELPER_INVALID');
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query(`REVOKE CREATE ON SCHEMA public FROM ${quote(appRole)}`);
    await db.query('REVOKE ALL ON SCHEMA codeworks FROM PUBLIC');
    await db.query(`REVOKE ALL ON SCHEMA codeworks FROM ${quote(appRole)}`);
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA codeworks FROM PUBLIC,${quote(appRole)}`);
    await db.query(`GRANT USAGE ON SCHEMA codeworks TO ${quote(appRole)}`);
    await db.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA codeworks TO ${quote(appRole)}`);
    await db.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA codeworks TO ${quote(appRole)}`);
    await db.query(`REVOKE ALL ON FUNCTION codeworks.lock_publication_evidence(text,uuid,uuid) FROM PUBLIC,${quote(appRole)}`);
    await db.query(`GRANT EXECUTE ON FUNCTION codeworks.lock_publication_evidence(text,uuid,uuid) TO ${quote(appRole)}`);
    await db.query(`REVOKE UPDATE ON codeworks.verified_ci FROM ${quote(appRole)}`);
    if(verifierRole){
      const v=(await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[verifierRole])).rows[0];
      if(!v||Object.values(v).some(Boolean)||[appRole,owner.role].includes(verifierRole)||(await db.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[verifierRole])).rowCount)throw Error('UNSAFE_VERIFIER_ROLE');
      await db.query(`GRANT USAGE ON SCHEMA codeworks TO ${quote(verifierRole)}`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA codeworks TO ${quote(verifierRole)}`);
      await db.query(`GRANT INSERT ON codeworks.verified_ci,codeworks.deployment_evidence,codeworks.installed TO ${quote(verifierRole)}`);
      await db.query(`GRANT UPDATE ON codeworks.installed,codeworks.deployments TO ${quote(verifierRole)}`);
      await db.query(`REVOKE INSERT,UPDATE ON codeworks.verified_ci,codeworks.deployment_evidence,codeworks.installed FROM ${quote(appRole)}`);
    }
    await db.query(`REVOKE ALL ON public.codeworks_migrations FROM PUBLIC,${quote(appRole)}`);
    const comments = { instance_id:'Постоянный ID экземпляра Codeworks.', owner:'Единственный владелец исполнения.', mutations_paused:'Приём новых намерений приостановлен для перехода.', workflow_id:'Постоянный Workflow ID независимо от retention.', generation:'Поколение переданного владения.', lifecycle:'Состояние задачи независимо от попыток выпуска.', next_sequence:'Последовательность приёма команд.', position:'Подтверждённая позиция обработки команд.', executor_state:'Последнее наблюдение исполнителя.', last_stage:'Последняя подтверждённая стадия.', blocked_reason:'Причина ожидания безопасной сверки.', started_at:'Время подтверждения запуска workflow.', completed_at:'Время окончательного закрытия приёма.', sequence:'Порядок команд внутри workflow.', admitted_request:'Неизменные параметры принятого поручения.', delivered_at:'Подтверждение доставки пробуждения.', ticket:'FIFO позиция в очереди контура.', release_operation_id:'Выпуск, разрешающий эту установку.', closed_at:'Время безопасного закрытия попытки.', close_reason:'Причина явного закрытия попытки.', archived:'Историческая запись исключена из автоматического исполнения.', removed_at:'Время удаления дерева; учётная запись сохраняется.', legacy_writer:'Историческое состояние прежнего контроллера, в исполнении не используется.', retry_of:'Предыдущий failed rollout, связанный с единственным trusted retry.', receipt:'Доверенный результат Ansible rollout.', composition_digest:'Immutable digest удостоверенного состава OCI.', composition:'Проверенный состав отдельных OCI компонентов.', previous_composition:'Предыдущая успешная поставка для защиты от cleanup.', run_id:'Точный удостоверенный GitHub Actions run.', attempt:'Номер удостоверенной попытки Actions.', policy_sha256:'Fingerprint принятой owner policy.', proof:'Однократно проверенное CI evidence; не agent report.', id:'Стабильный ID записи.', project_id:'Ссылка на собственный реестр проектов.', config:'Политика репозитория, путей, Git flow и доступа.', workspace_key:'Внешний ключ продолжения области без привязки к попытке.', element_id:'Необязательный стабильный Element ID game-core.', kind:'Вид операции или ветки.', base_ref:'Исходная ссылка Git; фиксируется при создании.', base_sha:'Неизменяемая база Git.', branch:'Зарезервированное имя ветки.', path:'Канонический путь рабочей области.', ownership_token:'Случайное доказательство владения внешними ресурсами.', preparation_state:'Последний подтверждённый этап подготовки.', writer:'Исполнитель, сессия, эпоха и active/quiesced права записи.', executor_id:'Удостоверенный транспортом исполнитель.', actor_id:'Необязательный заявленный инициатор.', workspace_id:'ID собственной рабочей области.', status:'Состояние durable операции.', step:'Последний сохранённый шаг.', request:'Исходные параметры операции.', result:'Фактический результат операции.', error:'Безопасная ошибка без инфраструктурных секретов.', created_at:'Время создания UTC.', updated_at:'Время последнего подтверждения UTC.', idempotency_key:'Ключ безопасного повтора в области проекта и исполнителя.', payload_sha256:'Хеш нормализованных параметров и имени операции.', operation_id:'ID первоначальной durable операции.', session_id:'Внешний ID сессии; не удостоверяет исполнителя.', move_id:'Отдельная ссылка на Move game-core.', attempt_id:'Отдельная ссылка на attempt game-core.', writer_epoch:'Версия права записи при подключении.', target:'Запрошенный контур выпуска.', requested_sha:'Точный commit запрошенного выпуска.', state:'Подтверждённое состояние запроса выпуска.', details:'Закреплённые Git/GitHub намерения и фактические результаты шагов.', commit_sha:'Точный commit проверенной установленной версии.', evidence_url:'Ссылка на доверенный отчёт rollout и проверки окружения.' };
    Object.assign(comments, {activation_state:'Историческая область либо подтверждённая первая запись.',first_write_at:'Первое фактическое изменение дерева.',outcome:'Результат задачи независимо от очистки.',turn_id:'Идентификатор хода native клиента.',tool_use_id:'Идентификатор фактического вызова инструмента.',tool_name:'Native инструмент без сохранения входного текста.',request_key:'Неизменяемый ключ первой подготовки.',targets:'Разобранные цели файловой записи.',rewritten_sha256:'Digest допущенного входа после изменения путей.',tool_result:'Только исход вызова и наличие фактических изменений.',baseline_head:'HEAD до допуска записи.',ready_at:'Подтверждённая готовность подготовки.',admitted_at:'Время допуска вызова к записи.',finished_at:'Подтверждённое завершение инструмента.',subject_key:'Стабильный субъект обязательства очистки.',source_operation_id:'Исходное сохранённое решение.',evidence:'Неизменные доказательства безопасного маршрута.',expected:'Закреплённые идентификаторы и OID ресурсов.',owner_workflow_id:'Единственный текущий процесс исполнения.',epoch:'Поколение передачи владения очисткой.',next_attempt_at:'Время следующего durable повтора.',blocker:'Точная причина ожидания.',attempts:'Число раундов безопасного восстановления.'});
    Object.assign(comments,{technical_attempts:'Число последовательных технических раундов без изменения принятого поручения.',retry_at:'Постоянный срок следующей безопасной проверки команды.'});
    Object.assign(comments,{write_call_id:'Точный допущенный native вызов записи.',completion_input_sha256:'Канонический хэш фактического перенаправленного входа для проверки Post.',completion_spool_cursor:'Сохранённая позиция ограниченного обхода журнала Post без голодания остальных вызовов.',receipt_sha256:'Неизменный хэш метаданных подтверждения.',notification:'Идентификаторы, хэши входа и исход native Post без текста файлов и вывода.'});
    const columns = (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='codeworks'")).rows;
    for (const column of columns) {
      if(column.column_name==='code_index')comments.code_index='Владение, источник и наблюдаемое состояние необязательного индекса области.';
      if (!comments[column.column_name]) throw new Error('COLUMN_COMMENT_REQUIRED');
      await db.query(`COMMENT ON COLUMN codeworks.${quote(column.table_name)}.${quote(column.column_name)} IS '${comments[column.column_name].replaceAll("'", "''")}'`);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.CODEWORKS_OWNER_DATABASE_URL });
  try { if (!process.env.CODEWORKS_OWNER_DATABASE_URL) throw new Error('OWNER_DATABASE_URL_REQUIRED'); await migrate(pool, process.env.CODEWORKS_APP_ROLE,process.env.CODEWORKS_VERIFIER_ROLE); console.log('codeworks migration complete'); }
  catch (error) { console.error(error.message?.startsWith('MIGRATION_') ? error.message : 'codeworks migration failed'); process.exitCode=1; }
  finally { await pool.end(); }
}
