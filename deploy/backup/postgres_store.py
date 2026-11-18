# ABOUTME: Проверяет PostgreSQL дампы настоящим восстановлением в изолированном контейнере.
# ABOUTME: Не подключает сеть или рабочие volumes и удаляет только свой помеченный контейнер.
import hashlib
import json
from pathlib import Path
import time
import tempfile
import uuid
from common import Failure, qi, run


def schema_digest(raw):
    """Нормализовать случайный psql restrict nonce и комментарии native pg_dump."""
    stable = '\n'.join(line for line in raw.decode().splitlines()
                       if line and not line.startswith(('--', '\\restrict', '\\unrestrict')))
    return hashlib.sha256(stable.encode()).hexdigest()


def command(container, user, program, *args):
    """Явно выбрать локальный Unix socket; credentials не нужны в argv."""
    return ['docker', 'exec', '-i', '--user', 'postgres', container, program, '-h', '/tmp', '-U', user, *args]


def fingerprint(container, user, database, *, excluded=(), local_socket=False, socket=None):
    """Сверить все колонки, строки, схемы и sequences без списка пользовательских таблиц."""
    def argv(program, *args):
        if local_socket:
            return command(container, user, program, *args)
        return ['docker', 'exec', '-i', '--user', 'postgres', container, program,
                '-h', socket or '/var/run/postgresql', '-U', user, *args]
    def sql(query):
        return run(argv('psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', query))
    tables = json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname) x;"))
    result = {'schema_sha256': schema_digest(run(argv('pg_dump', '--schema-only', '--dbname=' + database))), 'tables': {}}
    for table in tables:
        key = table['schema'] + '.' + table['name']
        query = 'SELECT md5(to_jsonb(t)::text) FROM ' + qi(table['schema']) + '.' + qi(table['name']) + ' t ORDER BY 1;'
        if key in excluded:
            continue
        # Поток строковых hashes не держит пользовательскую таблицу в RAM Python.
        h, count = hashlib.sha256(), 0
        with tempfile.TemporaryFile() as output:
            run(argv('psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', query), output=output)
            output.seek(0)
            for row in output:
                h.update(row)
                count += 1
        result['tables'][key] = {'rows': count, 'sha256': h.hexdigest()}
    result['role_settings'] = json.loads(sql("""SELECT coalesce(json_agg(x),'[]') FROM (
      SELECT coalesce(r.rolname,'') AS role,
        ARRAY(SELECT unnest(s.setconfig) ORDER BY 1) AS settings
      FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole
      WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())
      ORDER BY 1) x;"""))
    result['sequences'] = json.loads(sql("SELECT coalesce(json_agg(x),'[]') FROM (SELECT schemaname,sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value FROM pg_sequences ORDER BY schemaname,sequencename) x;"))
    result['large_objects'] = sql("SELECT loid,pageno,md5(data) FROM pg_largeobject ORDER BY loid,pageno;").decode()
    result['large_object_owners'] = sql("SELECT oid,lomowner::regrole::text,lomacl::text FROM pg_largeobject_metadata ORDER BY oid;").decode()
    return result


def isolated_verify(bundle, manifest):
    """Восстановить все БД/роли с исходным image и сравнить их с export fingerprints."""
    results = {}
    for source, cluster in manifest['postgres'].items():
        folder = Path(bundle) / 'postgres' / source
        identity = uuid.uuid4().hex
        container, bootstrap = 'brai-recovery-test-' + identity, 'recovery_' + identity
        created = False
        try:
            run(['docker', 'run', '-d', '--pull=never', '--name', container,
                 '--label', 'brai.recovery.test=' + identity, '--network=none', '--read-only',
                 '--tmpfs', '/tmp:rw,exec', '--user', 'postgres', '--entrypoint', '/bin/sh', cluster['image'], '-c',
                 'initdb -D /tmp/pgdata -U ' + bootstrap + ' --auth-local=trust --auth-host=reject >/dev/null && '
                 'exec postgres -D /tmp/pgdata -c listen_addresses= -c unix_socket_directories=/tmp'])
            created = True
            while run(command(container, bootstrap, 'pg_isready', '-d', 'postgres'), check=False):
                state = json.loads(run(['docker', 'inspect', container]))[0]
                if not state['State']['Running']:
                    raise Failure('RECOVERY_ISOLATED_POSTGRES_START_FAILED')
                time.sleep(0.2)
            with (folder / 'globals.sql').open('rb') as data:
                run(command(container, bootstrap, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'), input_file=data)
            restored = {}
            for name in cluster['databases']:
                # template1 остаётся технической БД соединения; postgres можно пересоздать.
                with (folder / (name + '.dump')).open('rb') as data:
                    run(command(container, bootstrap, 'pg_restore', '-d', 'template1', '--create', '--clean', '--if-exists', '--exit-on-error'), input_file=data)
                actual = fingerprint(container, bootstrap, name, local_socket=True)
                if actual != cluster['fingerprints'][name]:
                    raise Failure('RECOVERY_POSTGRES_RESTORE_MISMATCH')
                restored[name] = {'verified': True, 'tables': len(actual['tables'])}
            results[source] = restored
        finally:
            if created:
                state = json.loads(run(['docker', 'inspect', container]))[0]
                if state['Config']['Labels'].get('brai.recovery.test') != identity or state['HostConfig']['NetworkMode'] != 'none' or any(m.get('Type') != 'tmpfs' for m in state['Mounts']):
                    raise Failure('RECOVERY_TEST_CONTAINER_SCOPE_CHANGED')
                run(['docker', 'rm', '-f', container])
    return results
