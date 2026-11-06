# ABOUTME: Переносит владельцев памяти в lifecycle MemOS с проверяемым откатом.
# ABOUTME: Работает владельцем БД; недоказанные источники помещает в карантин.
"""Защищённые входы и фазы owner CLI описаны в MIGRATION.md."""

import argparse
import copy
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


class MigrationError(ValueError):
    """Отказ операции до commit; исходники не передаются в диагностику CLI."""


def canonical_hash(value):
    """Вернуть SHA256 канонического JSON для значения PostgreSQL to_jsonb."""
    result = hashlib.sha256()
    for block in _iter_json(value):
        result.update(block.encode())
    return result.hexdigest()


def _json(value):
    return ''.join(_iter_json(value))


def _iter_json(value):
    # Не создавать копию всего архива: реальный inventory превышает 256 МиБ.
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise MigrationError('Nonfinite JSON numeric')
        yield str(value)
    elif isinstance(value, dict):
        yield '{'
        for index, (key, item) in enumerate(sorted(value.items())):
            if index:
                yield ','
            yield json.dumps(key, ensure_ascii=False) + ':'
            yield from _iter_json(item)
        yield '}'
    elif isinstance(value, (list, tuple)):
        yield '['
        for index, item in enumerate(value):
            if index:
                yield ','
            yield from _iter_json(item)
        yield ']'
    else:
        yield json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def _parse_json(raw):
    return json.loads(raw, parse_float=Decimal, object_pairs_hook=_unique)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise MigrationError('Duplicate JSON key')
        result[key] = value
    return result


def _protected_parent(path):
    if not path.is_absolute():
        raise MigrationError('Absolute protected path required')
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise MigrationError('Unprotected directory')


def load_protected_json(path):
    """Прочитать root-owned обычный файл 0600 без symlink и повторных ключей."""
    path = Path(path)
    _protected_parent(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise MigrationError('Unprotected file')
        return _parse_json(stream.read())


def write_inventory(path, inventory):
    """Создать новый root-private inventory; существующий файл не заменять."""
    path = Path(path)
    _protected_parent(path)
    if os.geteuid() != 0:
        raise MigrationError('Inventory requires root')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            for block in _iter_json(inventory):
                stream.write(block)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink()
        raise


def _identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z_][a-z_0-9]{0,62}', value):
        raise MigrationError('Invalid SQL identifier')
    return '"' + value + '"'


def validate_config(config):
    """Проверить version, уникальность пользователей, профилей, scope и quarantine."""
    fields = {'version', 'dsn', 'schema', 'runtimeRoles', 'runId', 'mapping', 'quarantine', 'verifiedRows', 'freezeFile'}
    if not isinstance(config, dict) or set(config) != fields or type(config['version']) is not int or config['version'] != 1:
        raise MigrationError('Invalid config')
    for field in ('dsn', 'runId', 'freezeFile'):
        if not isinstance(config[field], str) or not config[field]:
            raise MigrationError('Missing config field')
    _identifier(config['schema'])
    _identifier(config['schema'] + '_brai_owner')
    roles = config['runtimeRoles']
    if not isinstance(roles, list) or not roles or any(not isinstance(r, str) for r in roles) or len(set(roles)) != len(roles):
        raise MigrationError('Runtime roles required')
    for role in roles:
        _identifier(role)
    mapping = config['mapping']
    if not isinstance(mapping, dict) or not mapping or not isinstance(config['verifiedRows'], dict):
        raise MigrationError('Invalid provenance mapping')
    users, profiles, scopes = set(), set(), set()
    for author, entry in [*mapping.items(), (None, config['quarantine'])]:
        required = {'userId', 'profileId', 'homeScope', 'memoryEpoch'}
        if author is not None:
            required |= {'authorId', 'cubes'}
        if not isinstance(entry, dict) or set(entry) != required or any(not isinstance(entry[k], str) or not entry[k] for k in required - {'cubes'}):
            raise MigrationError('Invalid profile mapping')
        if author is not None:
            if not re.fullmatch(r'[1-9][0-9]*', author) or entry['authorId'] != author:
                raise MigrationError('Invalid author mapping')
            cubes = entry['cubes']
            if not isinstance(cubes, dict) or not cubes or any(not isinstance(k, str) or not k or v != entry['profileId'] + '__' + k for k, v in cubes.items()):
                raise MigrationError('Invalid cube mapping')
        scope = (entry['homeScope'], entry['memoryEpoch'])
        if entry['userId'] in users or entry['profileId'] in profiles or scope in scopes:
            raise MigrationError('Conflicting profiles')
        users.add(entry['userId'])
        profiles.add(entry['profileId'])
        scopes.add(scope)
    for memory_id, evidence in config['verifiedRows'].items():
        if (not isinstance(memory_id, str) or not memory_id or not isinstance(evidence, dict)
                or set(evidence) != {'authorId', 'rowHash', 'evidenceRefs'}
                or evidence['authorId'] not in mapping
                or not isinstance(evidence['rowHash'], str) or not re.fullmatch('[a-f0-9]{64}', evidence['rowHash'])
                or not isinstance(evidence['evidenceRefs'], list) or not evidence['evidenceRefs']
                or any(not isinstance(ref, str) or not ref for ref in evidence['evidenceRefs'])):
            raise MigrationError('Invalid verified evidence')
    return config


def _config_hash(config):
    return canonical_hash({k: v for k, v in config.items() if k not in ('dsn', 'freezeFile', 'runId')})


def _explicit_authors(value):
    result = set()
    if isinstance(value, list):
        for item in value:
            result.update(_explicit_authors(item))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in ('author_id', 'authorId', 'sender_id', 'senderId', 'hermes_author_id'):
                result.add(str(item))
            elif key in ('sender', 'author', 'from') and isinstance(item, dict) and 'id' in item:
                result.add(str(item['id']))
            else:
                result.update(_explicit_authors(item))
    return result


def _info(row):
    properties = row.get('properties')
    info = properties.get('info') if isinstance(properties, dict) else None
    return info if isinstance(info, dict) else {}


def classify_rows(rows, config):
    """Назначить автора только при exact-row аттестации и согласованных источниках.

    Неизвестный источник и смешанные копии события распространяют карантин
    до неподвижной точки. Имена, упоминания и контент не доказывают авторство.
    """
    if len({r['id'] for r in rows}) != len(rows):
        raise MigrationError('Duplicate memory identity')
    authors, refs, groups = {}, {}, {}
    for row in rows:
        memory_id, info = row['id'], _info(row)
        evidence, author = config['verifiedRows'].get(memory_id), info.get('hermes_author_id')
        valid = (isinstance(author, str) and author in config['mapping'] and evidence
                 and evidence['authorId'] == author and evidence['rowHash'] == canonical_hash(row)
                 and row.get('user_name') in config['mapping'][author]['cubes']
                 and not info.get('hermes_quarantined')
                 and _explicit_authors(info.get('hermes_messages', [])) <= {author})
        if valid:
            cubes = config['mapping'][author]['cubes']
            metadata_cubes = [info[k] for k in ('hermes_cube', 'hermes_primary_cube') if k in info]
            memberships = info.get('hermes_memberships', [])
            valid = (isinstance(memberships, list) and all(isinstance(c, str) and c in cubes for c in memberships)
                     and all(isinstance(c, str) and c in cubes for c in metadata_cubes))
        authors[memory_id] = author if valid else None
        source_ids = info.get('hermes_source_ids', [])
        refs[memory_id] = set(source_ids) if isinstance(source_ids, list) and all(isinstance(s, str) for s in source_ids) else {None}
        for field in ('hermes_event_id', 'hermes_logical_id'):
            token = info.get(field)
            if isinstance(token, str) and token:
                groups.setdefault((field, token), set()).add(memory_id)
    for row in rows:
        source_event = _info(row).get('hermes_source_event')
        if source_event:
            refs[row['id']].update(groups.get(('hermes_event_id', str(source_event)), {None}))
    changed = True
    while changed:
        changed = False
        for group in groups.values():
            if len({authors[i] for i in group}) > 1:
                for memory_id in group:
                    if authors[memory_id] is not None:
                        authors[memory_id] = None
                        changed = True
        for memory_id, sources in refs.items():
            author = authors[memory_id]
            if author is not None and any(authors.get(source) != author for source in sources):
                authors[memory_id] = None
                changed = True
    return authors


def _dataset_hash(rows, edges):
    return canonical_hash({'rows': sorted(rows, key=lambda r: r['id']), 'edges': sorted(edges, key=lambda e: e['id'])})


def build_plan(rows, edges, config):
    """Сформировать перенос без изменения контента, embeddings и дат."""
    authors, migrated = classify_rows(rows, config), []
    for original in rows:
        row = copy.deepcopy(original)
        author = authors[row['id']]
        owner = config['mapping'][author] if author else config['quarantine']
        properties = row['properties']
        if not isinstance(properties, dict) or properties.get('info') is not None and not isinstance(properties['info'], dict):
            raise MigrationError('Unsupported memory metadata')
        if properties.get('info') is None:
            properties['info'] = {}
        info = properties['info']
        properties['user_id'] = owner['userId']
        info.update(hermes_home_scope=owner['homeScope'], hermes_memory_epoch=owner['memoryEpoch'],
                    hermes_profile_id=owner['profileId'], hermes_user_id=owner['userId'])
        old_cube = row.get('user_name')
        if author:
            cubes = owner['cubes']
            convert = cubes.__getitem__
        else:
            # Карантин не попадает в legacy category куб или профиль администратора.
            convert = lambda cube: owner['profileId'] + '__' + (cube if isinstance(cube, str) and cube else 'unknown')
            info['hermes_quarantined'] = True
        row['user_name'] = convert(old_cube)
        primary = info.get('hermes_primary_cube', old_cube)
        memberships = info.get('hermes_memberships', [old_cube])
        info['hermes_cube'] = row['user_name']
        info['hermes_primary_cube'] = convert(primary)
        info['hermes_memberships'] = [convert(cube) for cube in memberships] if isinstance(memberships, list) else [row['user_name']]
        migrated.append(row)
    kept, removed = [], []
    for edge in edges:
        a, b = authors.get(edge['source_id']), authors.get(edge['target_id'])
        (kept if a is not None and a == b else removed).append(edge)
    source_hash, config_hash = _dataset_hash(rows, edges), _config_hash(config)
    summary = {'rows': len(rows), 'assigned': sum(a is not None for a in authors.values()),
               'quarantined': sum(a is None for a in authors.values()), 'edges': len(edges),
               'keptEdges': len(kept), 'archivedEdges': len(removed), 'sourceHash': source_hash,
               'configHash': config_hash, 'postHash': _dataset_hash(migrated, kept)}
    summary['preflightHash'] = canonical_hash({'sourceHash': source_hash, 'configHash': config_hash})
    return {'rows': migrated, 'kept': kept, 'removed': removed, 'summary': summary}


def _read(cur, schema, table):
    cur.execute(f'SELECT to_jsonb(t) FROM {schema}.{table} t ORDER BY id')
    return [item[0] for item in cur.fetchall()]


def _owner_checks(cur, config, archive_exists=False):
    schema = config['schema']
    cur.execute('SELECT current_user')
    owner = cur.fetchone()[0]
    for table in ('memories', 'edges'):
        cur.execute('SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=%s::regclass', (f'{schema}.{table}',))
        if cur.fetchone()[0] != owner:
            raise MigrationError('MemOS table owner connection required')
    for role in config['runtimeRoles']:
        cur.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,))
        if cur.fetchone() is None:
            raise MigrationError('Unknown runtime role')
        cur.execute("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE pg_has_role(%s,oid,'MEMBER') AND (rolsuper OR rolcreaterole OR rolbypassrls OR rolreplication)),pg_has_role(%s,%s,'MEMBER')", (role, role, owner))
        if any(cur.fetchone()):
            raise MigrationError('Unsafe runtime role')
    if not archive_exists:
        return
    archive = schema + '_brai_owner'
    cur.execute('SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=%s', (archive,))
    if cur.fetchone()[0] != owner:
        raise MigrationError('Archive owner mismatch')
    cur.execute("SELECT EXISTS(SELECT 1 FROM pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=%s AND a.grantee=0)", (archive,))
    if cur.fetchone()[0]:
        raise MigrationError('Archive schema accessible to PUBLIC')
    for role in config['runtimeRoles']:
        cur.execute("SELECT has_schema_privilege(%s,%s,'USAGE,CREATE')", (role, archive))
        if cur.fetchone()[0]:
            raise MigrationError('Archive schema accessible to runtime')
    for table in ('runs', 'memories', 'edges'):
        cur.execute('SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=%s::regclass', (f'{archive}.{table}',))
        if cur.fetchone()[0] != owner:
            raise MigrationError('Archive table owner mismatch')
        for role in config['runtimeRoles']:
            cur.execute("SELECT has_table_privilege(%s,%s,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')", (role, f'{archive}.{table}'))
            if cur.fetchone()[0]:
                raise MigrationError('Archive table accessible to runtime')
        cur.execute("SELECT EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=%s::regclass AND a.grantee=0)", (f'{archive}.{table}',))
        if cur.fetchone()[0]:
            raise MigrationError('Archive table accessible to PUBLIC')


def _create_archive(cur, config, live, archive):
    cur.execute(f'CREATE SCHEMA IF NOT EXISTS {archive}')
    cur.execute(f'REVOKE ALL ON SCHEMA {archive} FROM PUBLIC')
    cur.execute(f'CREATE TABLE IF NOT EXISTS {archive}.runs (run_id text PRIMARY KEY,config_hash text NOT NULL,preflight_hash text NOT NULL,state text NOT NULL,summary jsonb NOT NULL,manifest jsonb NOT NULL)')
    for table in ('memories', 'edges'):
        cur.execute(f'CREATE TABLE IF NOT EXISTS {archive}.{table} AS SELECT t.*,NULL::text AS run_id FROM {live}.{table} t WITH NO DATA')
        cur.execute(f'ALTER TABLE {archive}.{table} ALTER COLUMN run_id SET NOT NULL')
        cur.execute(f'CREATE UNIQUE INDEX IF NOT EXISTS {table}_run_id ON {archive}.{table}(run_id,id)')
    for role in ['PUBLIC', *[_identifier(r) for r in config['runtimeRoles']]]:
        cur.execute(f'REVOKE ALL ON SCHEMA {archive} FROM {role}')
        cur.execute(f'REVOKE ALL ON ALL TABLES IN SCHEMA {archive} FROM {role}')
    _owner_checks(cur, config, archive_exists=True)


def _ownership_patch(row):
    info = row['properties']['info']
    keys = ('hermes_home_scope', 'hermes_memory_epoch', 'hermes_profile_id', 'hermes_user_id',
            'hermes_quarantined', 'hermes_cube', 'hermes_primary_cube', 'hermes_memberships')
    return row['properties']['user_id'], {key: info[key] for key in keys if key in info}


def _expected_sql(properties):
    # Менять только ownership metadata, сохраняя неизвестные JSONB поля точно.
    return f"jsonb_set(jsonb_set({properties},'{{user_id}}',%s::jsonb,true),'{{info}}',coalesce(nullif({properties}->'info','null'::jsonb),'{{}}'::jsonb)||%s::jsonb,true)"


def _assert_exact_rows(cur, live, archive, run_id, expected, applied):
    for row in expected:
        if applied:
            user_id, info = _ownership_patch(row)
            expression = f"jsonb_set(jsonb_set(to_jsonb(s)-'run_id','{{properties}}',{_expected_sql('s.properties')},true),'{{user_name}}',%s::jsonb,true)"
            params = [_json(user_id), _json(info), _json(row['user_name'])]
        else:
            expression, params = "to_jsonb(s)-'run_id'", []
        cur.execute(f'SELECT to_jsonb(m) IS NOT DISTINCT FROM {expression} FROM {archive}.memories s LEFT JOIN {live}.memories m ON m.id=s.id WHERE s.run_id=%s AND s.id=%s',
                    (*params, run_id, row['id']))
        result = cur.fetchone()
        if result is None or result[0] is not True:
            raise MigrationError('Migrated row changed; rollback conflict')


def _assert_private_edges(rows, edges, config):
    owners = {(p['userId'], p['profileId'], p['homeScope'], p['memoryEpoch'])
              for p in config['mapping'].values()}
    scopes = {}
    for row in rows:
        properties, info = row.get('properties'), _info(row)
        if isinstance(properties, dict) and not info.get('hermes_quarantined'):
            scopes[row['id']] = (properties.get('user_id'), info.get('hermes_profile_id'),
                                 info.get('hermes_home_scope'), info.get('hermes_memory_epoch'))
    for edge in edges:
        source, target = scopes.get(edge['source_id']), scopes.get(edge['target_id'])
        if source not in owners or source != target:
            raise MigrationError('Live edge violates private scope')


def run_phase(connection, config, phase, *, frozen=False, preflight_hash=None):
    """Исполнить фазу в одной транзакции; CAS rollback сохраняет новые записи.

    Вызывающий владеет соединением. Отказ откатывает всю фазу. CLI отдельно
    проверяет защищённый freeze marker; frozen здесь — подтверждение lifecycle.
    """
    validate_config(config)
    from psycopg2.extras import register_default_jsonb
    register_default_jsonb(connection, loads=_parse_json)
    live, archive_name, run_id = _identifier(config['schema']), config['schema'] + '_brai_owner', config['runId']
    archive = _identifier(archive_name)
    with connection:
        with connection.cursor() as cur:
            cur.execute("SET LOCAL timezone='UTC'")
            cur.execute("SET LOCAL datestyle='ISO, YMD'")
            cur.execute("SET LOCAL lock_timeout='30s'")
            cur.execute("SET LOCAL statement_timeout='30min'")
            # Оба lock берутся ДО повторного чтения источника и проверки hash.
            mode = 'ACCESS EXCLUSIVE' if phase in ('apply', 'rollback') else 'SHARE'
            cur.execute(f'LOCK TABLE {live}.memories,{live}.edges IN {mode} MODE')
            _owner_checks(cur, config)
            rows, edges = _read(cur, live, 'memories'), _read(cur, live, 'edges')
            if phase == 'inventory':
                return {'version': 1, 'rows': [{'id': r['id'], 'rowHash': canonical_hash(r), 'row': r} for r in rows], 'edges': edges, 'sourceHash': _dataset_hash(rows, edges)}
            if phase == 'plan':
                return dict(build_plan(rows, edges, config)['summary'], state='planned')
            if phase not in ('apply', 'verify', 'rollback'):
                raise MigrationError('Unknown phase')
            if phase in ('apply', 'rollback') and (not frozen or not preflight_hash):
                raise MigrationError('Freeze and preflight hash required')
            cur.execute('SELECT to_regnamespace(%s)', (archive_name,))
            saved = None
            if cur.fetchone()[0] is not None:
                _owner_checks(cur, config, archive_exists=True)
                cur.execute(f'SELECT config_hash,preflight_hash,state,summary,manifest FROM {archive}.runs WHERE run_id=%s FOR UPDATE', (run_id,))
                saved = cur.fetchone()
                if phase == 'apply' and not saved:
                    cur.execute(f"SELECT EXISTS(SELECT 1 FROM {archive}.runs WHERE state='applied')")
                    if cur.fetchone()[0]:
                        raise MigrationError('Another migration is active')
            manifest = {k: v for k, v in config.items() if k not in ('dsn', 'freezeFile')}
            if saved and (saved[0] != _config_hash(config) or saved[4] != manifest or phase != 'verify' and saved[1] != preflight_hash):
                raise MigrationError('Run manifest mismatch')
            if phase == 'apply' and not saved:
                plan = build_plan(rows, edges, config)
                if plan['summary']['preflightHash'] != preflight_hash:
                    raise MigrationError('Preflight changed')
                _create_archive(cur, config, live, archive)
                for table in ('memories', 'edges'):
                    cur.execute(f'INSERT INTO {archive}.{table} SELECT t.*,%s FROM {live}.{table} t', (run_id,))
                for row in plan['rows']:
                    user_id, info = _ownership_patch(row)
                    cur.execute(f'UPDATE {live}.memories SET properties={_expected_sql("properties")},user_name=%s WHERE id=%s', (_json(user_id), _json(info), row['user_name'], row['id']))
                for edge in plan['removed']:
                    cur.execute(f'DELETE FROM {live}.edges WHERE id=%s', (edge['id'],))
                if _dataset_hash(_read(cur, live, 'memories'), _read(cur, live, 'edges')) != plan['summary']['postHash']:
                    raise MigrationError('Post-apply verification failed')
                cur.execute(f'INSERT INTO {archive}.runs VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb)', (run_id, _config_hash(config), preflight_hash, 'applied', json.dumps(plan['summary']), json.dumps(manifest)))
                return dict(plan['summary'], state='applied')
            if not saved:
                raise MigrationError('Run not found')
            if phase == 'apply' and saved[2] != 'applied':
                raise MigrationError('Run already rolled back')
            cur.execute(f"SELECT to_jsonb(t)-'run_id' FROM {archive}.memories t WHERE run_id=%s ORDER BY id", (run_id,))
            originals = [r[0] for r in cur.fetchall()]
            cur.execute(f"SELECT to_jsonb(t)-'run_id' FROM {archive}.edges t WHERE run_id=%s ORDER BY id", (run_id,))
            original_edges = [r[0] for r in cur.fetchall()]
            plan = build_plan(originals, original_edges, config)
            if plan['summary'] != saved[3] or saved[2] not in ('applied', 'rolled_back'):
                raise MigrationError('Archive manifest corrupt')
            expected = plan['rows'] if saved[2] == 'applied' else originals
            current = {r['id']: r for r in rows}
            if any(canonical_hash(current.get(r['id'])) != canonical_hash(r) for r in expected):
                raise MigrationError('Migrated row changed; rollback conflict')
            _assert_exact_rows(cur, live, archive, run_id, expected, saved[2] == 'applied')
            expected_edges = plan['kept'] if saved[2] == 'applied' else original_edges
            actual_edges = {e['id']: e for e in edges}
            if any(actual_edges.get(e['id']) != e for e in expected_edges):
                raise MigrationError('Migrated edge changed; rollback conflict')
            if saved[2] == 'applied' and any(e['id'] in actual_edges for e in plan['removed']):
                raise MigrationError('Archived edge identity reused')
            if phase in ('apply', 'verify') and saved[2] == 'applied':
                _assert_private_edges(rows, edges, config)
            if phase == 'rollback' and saved[2] == 'applied':
                original_ids, kept_ids = {r['id'] for r in originals}, {e['id'] for e in plan['kept']}
                if any(e['id'] not in kept_ids and (e['source_id'] in original_ids or e['target_id'] in original_ids) for e in edges):
                    raise MigrationError('New edge touches migrated row; rollback conflict')
                triples = {(e['source_id'], e['target_id'], e['edge_type']) for e in edges}
                if any((e['source_id'], e['target_id'], e['edge_type']) in triples for e in plan['removed']):
                    raise MigrationError('Archived edge key reused')
                cur.execute(f'UPDATE {live}.memories m SET properties=s.properties,user_name=s.user_name FROM {archive}.memories s WHERE s.run_id=%s AND s.id=m.id', (run_id,))
                for edge in plan['removed']:
                    cur.execute(f'INSERT INTO {live}.edges (id,source_id,target_id,edge_type,created_at) SELECT id,source_id,target_id,edge_type,created_at FROM {archive}.edges WHERE run_id=%s AND id=%s', (run_id, edge['id']))
                _assert_exact_rows(cur, live, archive, run_id, originals, False)
                expected_after = dict(current)
                expected_after.update({r['id']: r for r in originals})
                after_rows, after_edges = _read(cur, live, 'memories'), _read(cur, live, 'edges')
                current_hash = _dataset_hash(after_rows, after_edges)
                if current_hash != _dataset_hash(list(expected_after.values()), edges + plan['removed']):
                    raise MigrationError('Post-rollback verification failed')
                cur.execute(f"UPDATE {archive}.runs SET state='rolled_back' WHERE run_id=%s", (run_id,))
                return dict(saved[3], state='rolled_back', newRows=len(rows)-len(originals),
                            currentRows=len(after_rows), currentEdges=len(after_edges), currentHash=current_hash)
            return dict(saved[3], state=saved[2], newRows=len(rows)-len(originals),
                        currentRows=len(rows), currentEdges=len(edges), currentHash=_dataset_hash(rows, edges))


def main(argv=None):
    """Owner-only CLI; stdout содержит только счётчики, состояния и hashes."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--phase', required=True, choices=('inventory', 'plan', 'apply', 'verify', 'rollback'))
    parser.add_argument('--frozen', action='store_true')
    parser.add_argument('--preflight-hash')
    parser.add_argument('--inventory-output')
    args = parser.parse_args(argv)
    try:
        config = validate_config(load_protected_json(args.config))
        if args.phase in ('apply', 'rollback'):
            marker = load_protected_json(config['freezeFile'])
            if not isinstance(marker, dict) or set(marker) != {'runId', 'frozen'} or marker['runId'] != config['runId'] or marker['frozen'] is not True or not args.frozen:
                raise MigrationError('Lifecycle freeze marker required')
        if args.phase == 'inventory' and not args.inventory_output:
            raise MigrationError('Private inventory output required')
        import psycopg2
        connection = psycopg2.connect(config['dsn'])
        try:
            result = run_phase(connection, config, args.phase, frozen=args.frozen, preflight_hash=args.preflight_hash)
        finally:
            connection.close()
        if args.phase == 'inventory':
            write_inventory(args.inventory_output, result)
            result = {'state': 'inventoried', 'rows': len(result['rows']), 'edges': len(result['edges']), 'sourceHash': result['sourceHash']}
        print(json.dumps(result, sort_keys=True))
        return 0
    except MigrationError as error:
        print(json.dumps({'state': 'failed', 'error': str(error)}), file=sys.stderr)
        return 1
    except Exception:
        # Driver может включить SQL, DSN и память в exception: наружу только код.
        print(json.dumps({'state': 'failed', 'error': 'owner_migration_refused'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
