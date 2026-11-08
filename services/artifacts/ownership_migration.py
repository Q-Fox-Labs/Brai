# ABOUTME: Планирует перенос legacy владельцев Artifacts без изменения IDs и байтов.
# ABOUTME: SQL выполняет только оператор владельца; непроверенные файлы уходят в непродуктовый карантин.
import copy
import hashlib
import json
import re

TABLES = {
    'artifacts': ('artifacts', [('artifact_id','uuid'),('request_id','text'),('owner_id','text'),('kind','text'),
        ('status','text'),('source','text'),('size_bytes','bigint'),('created_at','timestamptz'),
        ('upload_token','text'),('document','jsonb')], ['artifact_id']),
    'references': ('artifact_references', [('owner_id','text'),('project_id','text'),('thread_id','text'),
        ('operation_id','text'),('document','jsonb')], ['owner_id','project_id','thread_id','operation_id']),
    'outputs': ('artifact_output_bindings', [('owner_id','text'),('project_id','text'),('thread_id','text'),
        ('item_id','text'),('document','jsonb')], ['owner_id','project_id','thread_id','item_id']),
    'relations': ('artifact_relations', [('model_artifact_id','uuid'),('original_artifact_id','uuid'),
        ('document','jsonb')], ['model_artifact_id','original_artifact_id']),
    'links': ('artifact_links', [('link_id','text'),('request_id','text'),('artifact_id','uuid'),
        ('token','text'),('document','jsonb')], ['link_id']),
}
ARCHIVE = 'artifacts_brai_owner'


class MigrationError(ValueError):
    """Безопасный отказ оператора без пользовательских значений."""


def canonical(value):
    """Сериализовать source и plan одинаково при повторном запуске."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    """Получить SHA-256 канонического JSON без публикации самого значения."""
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def _require(value, code):
    if not value:
        raise MigrationError(code)


def key(name, row):
    """Получить точный неизменяемый PK исходной записи."""
    return tuple(row[column] for column in TABLES[name][2])


def normalize(snapshot):
    """Проверить полный typed snapshot пяти известных таблиц Artifacts."""
    _require(isinstance(snapshot, dict) and set(snapshot) == set(TABLES), 'SNAPSHOT_TABLES_CHANGED')
    result = {}
    for name, (_, columns, _) in TABLES.items():
        rows = snapshot[name]
        _require(isinstance(rows, list), 'INVALID_SNAPSHOT_ROWS')
        expected = {column for column, _ in columns}
        _require(all(isinstance(row, dict) and set(row) == expected for row in rows), 'SNAPSHOT_COLUMNS_CHANGED')
        _require(len({key(name,row) for row in rows}) == len(rows), 'DUPLICATE_SNAPSHOT_KEY')
        result[name] = sorted(copy.deepcopy(rows), key=lambda row: key(name,row))
    return result


def referenced_ids(name, row):
    """Прочитать только контрактные artifact ID полей reference/output."""
    document = row['document']
    if name == 'references':
        return {item[field] for item in document.get('attachments', [])
                for field in ('originalArtifactId','modelArtifactId') if item.get(field)}
    if name == 'outputs':
        return set(document.get('artifactIds', []))
    return set()


def build_plan(snapshot, config):
    """Назначить owner только по operator evidence; сохранить остальные поля точь-в-точь."""
    before = normalize(snapshot)
    original, quarantine = config['originalOwnerId'], config['quarantineOwnerId']
    owners = set(config['allowedOwners'])
    _require(isinstance(original,str) and original in owners and quarantine not in owners
             and isinstance(quarantine,str) and 1 <= len(quarantine) <= 128, 'INVALID_OWNER_MAPPING')
    for field in ('accountsHash','provenanceHash','ownerSoftwareHash'):
        _require(bool(re.fullmatch('[0-9a-f]{64}', config.get(field,''))), 'INVALID_INPUT_HASH')
    _require(isinstance(config.get('runId'),str) and bool(re.fullmatch('[a-zA-Z0-9_-]{1,100}',config['runId'])), 'INVALID_RUN_ID')
    artifacts = {row['artifact_id']:row for row in before['artifacts']}
    assignments = config.get('assignments', {})
    _require(not set(assignments)-set(artifacts), 'UNKNOWN_ASSIGNMENT')
    targets = {}
    for aid,row in artifacts.items():
        record = row['document']
        _require(record['artifact'].get('artifactId') == aid and record['artifact'].get('requestId') == row['request_id'], 'SOURCE_ARTIFACT_ID_MISMATCH')
        _require(row['owner_id'] == original and record['artifact']['ownerId'] == original
                 and record['prepareInput']['ownerId'] == original, 'SOURCE_OWNER_MISMATCH')
        target = assignments.get(aid, quarantine)
        _require(target in owners or target == quarantine, 'UNKNOWN_TARGET_OWNER')
        targets[aid] = target
    # Связанные копии не могут остаться у разных owners: смешанный component целиком в карантин.
    parent = {aid:aid for aid in artifacts}
    def root(aid):
        while parent[aid] != aid:
            parent[aid] = parent[parent[aid]]
            aid = parent[aid]
        return aid
    for row in before['relations']:
        a,b = row['model_artifact_id'],row['original_artifact_id']
        _require(a in artifacts and b in artifacts, 'EXTERNAL_RELATION_REQUIRES_REVIEW')
        parent[root(a)] = root(b)
    components = {}
    for aid in artifacts:
        components.setdefault(root(aid), []).append(aid)
    for component in components.values():
        if len({targets[aid] for aid in component}) != 1:
            for aid in component:
                targets[aid] = quarantine
    after = copy.deepcopy(before)
    for row in after['artifacts']:
        owner = targets[row['artifact_id']]
        row['owner_id'] = owner
        row['document']['artifact']['ownerId'] = owner
        row['document']['prepareInput']['ownerId'] = owner
    for row in before['links']:
        if row['artifact_id'] in artifacts:
            _require(row['document'].get('link',{}).get('revokedAt'), 'ACTIVE_SHARING_REQUIRES_REVIEW')
    archived = {}
    for name in ('references','outputs'):
        retained, removed = [], []
        for row in before[name]:
            current = row['owner_id']
            path = row['document'].get('scope',{}) if name == 'references' else row['document']
            _require(path.get('ownerId') == current, 'BINDING_OWNER_MISMATCH')
            ids = referenced_ids(name,row)
            _require(not ids-set(artifacts)-set(config.get('externalOwners',{})), 'UNKNOWN_BINDING_ARTIFACT')
            candidates = {targets.get(aid,config.get('externalOwners',{}).get(aid)) for aid in ids}
            proof = config.get('bindingOwners',{}).get(name,{}).get(digest(list(key(name,row))))
            target = current if not ids or candidates == {current} else (
                proof if len(candidates)==1 and proof in candidates and proof in owners else None)
            if target is None or target == quarantine:
                removed.append(row)
                continue
            changed = copy.deepcopy(row)
            changed['owner_id'] = target
            target_path = changed['document'].get('scope',{}) if name == 'references' else changed['document']
            target_path['ownerId'] = target
            retained.append(changed)
        after[name], archived[name] = retained, len(removed)
    after = normalize(after)
    plan = {'version':1, 'runId':config['runId'], 'originalOwnerId':original,'quarantineOwnerId':quarantine,
        'accountsHash':config['accountsHash'],'provenanceHash':config['provenanceHash'],
        'ownerSoftwareHash':config['ownerSoftwareHash'],'sourceHash':digest(before),'postHash':digest(after),
        'before':before,'after':after,'summary':{'artifacts':len(artifacts),
            'assigned':sum(owner!=quarantine for owner in targets.values()),
            'transferred':sum(owner not in (original,quarantine) for owner in targets.values()),
            'quarantined':sum(owner==quarantine for owner in targets.values()),
            'archivedReferences':archived['references'],'archivedOutputs':archived['outputs']}}
    plan['planHash'] = digest(plan)
    return plan


def _literal(value):
    return "'" + value.replace("'", "''") + "'"


def _json_literal(value):
    return _literal(canonical(value)) + '::jsonb'


def _record_type(name):
    return ','.join(column+' '+kind for column,kind in TABLES[name][1])


def _rows(name, phase, plan):
    return "jsonb_to_recordset(" + _json_literal(plan[phase][name]) + ") AS x(" + _record_type(name) + ")"


def _keys_condition(name, alias, rows):
    if not rows:
        return 'false'
    keys = TABLES[name][2]
    return ' OR '.join('('+' AND '.join(alias+'.'+column+'::text='+_literal(str(row[column])) for column in keys)+')' for row in rows)


def _touches(name, alias, ids):
    selected = '('+','.join(_literal(aid) for aid in ids)+')' if ids else '(NULL)'
    if name == 'relations':
        return f'({alias}.model_artifact_id::text IN {selected} OR {alias}.original_artifact_id::text IN {selected})'
    if name == 'links':
        return f'{alias}.artifact_id::text IN {selected}'
    if name == 'references':
        return ("EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE("+alias+".document->'attachments','[]'::jsonb)) a "
                f"WHERE a->>'originalArtifactId' IN {selected} OR a->>'modelArtifactId' IN {selected})")
    if name == 'outputs':
        return ("EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE("+alias+".document->'artifactIds','[]'::jsonb)) a "
                f"WHERE a IN {selected})")
    return _keys_condition(name,alias,[{'artifact_id':aid} for aid in ids])


def snapshot_sql(original_owner):
    """Read-only source projection; никакие данные или tokens не выводятся самим модулем."""
    aid = "SELECT artifact_id::text FROM artifacts.artifacts WHERE owner_id="+_literal(original_owner)
    selected = 'ARRAY('+aid+')'
    parts = []
    for name,(table,_,_) in TABLES.items():
        if name == 'artifacts':
            where = 't.owner_id='+_literal(original_owner)
        elif name == 'relations':
            where = f'(t.model_artifact_id::text=ANY({selected}) OR t.original_artifact_id::text=ANY({selected}))'
        elif name == 'links':
            where = f't.artifact_id::text=ANY({selected})'
        elif name == 'references':
            where = ('t.owner_id='+_literal(original_owner)+" OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.document->'attachments','[]')) a "
                     f"WHERE a->>'originalArtifactId'=ANY({selected}) OR a->>'modelArtifactId'=ANY({selected}))")
        else:
            where = ('t.owner_id='+_literal(original_owner)+" OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.document->'artifactIds','[]')) a "
                     f"WHERE a=ANY({selected}))")
        parts.extend([_literal(name),f"(SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM artifacts.{table} t WHERE {where})"])
    return "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL timezone='UTC'; SELECT jsonb_build_object("+','.join(parts)+"); COMMIT;"


def _selection(name, plan, initial=False):
    rows = plan['before'][name] + plan['after'][name]
    ids = [row['artifact_id'] for row in plan['before']['artifacts']]
    keys = _keys_condition(name,'t',rows)
    if name == 'artifacts':
        return 't.owner_id='+_literal(plan['originalOwnerId']) if initial else keys
    extra = _touches(name,'t',ids)
    if initial and name in ('references','outputs'):
        extra += ' OR t.owner_id='+_literal(plan['originalOwnerId'])
    return '('+keys+' OR '+extra+')'


def _assert_rows(plan, phase, initial=False):
    checks = []
    for name,(table,_,_) in TABLES.items():
        current = f'SELECT to_jsonb(t) AS row FROM artifacts.{table} t WHERE '+_selection(name,plan,initial)
        expected = 'SELECT to_jsonb(x) AS row FROM '+_rows(name,phase,plan)
        checks.append("IF EXISTS(("+current+") EXCEPT ("+expected+")) OR EXISTS(("+expected+") EXCEPT ("+current+")) THEN RAISE EXCEPTION 'ARTIFACT_OWNER_CAS_FAILED'; END IF;")
    return '\n'.join(checks)


def _write_rows(plan, phase):
    statements = []
    for name in ('artifacts','references','outputs'):
        table,columns,keys = TABLES[name]
        if name == 'artifacts':
            statements.append("UPDATE artifacts.artifacts t SET owner_id=x.owner_id,document=x.document FROM "+_rows(name,phase,plan)+" WHERE t.artifact_id=x.artifact_id;")
        else:
            statements.append(f'DELETE FROM artifacts.{table} t WHERE '+_keys_condition(name,'t',plan['before'][name]+plan['after'][name])+';')
            names = ','.join(column for column,_ in columns)
            statements.append(f'INSERT INTO artifacts.{table}({names}) SELECT {names} FROM '+_rows(name,phase,plan)+';')
    return '\n'.join(statements)


def _do(body):
    index = 0
    tag = '$brai_owner_0$'
    while tag in body:
        index += 1
        tag = '$brai_owner_' + str(index) + '$'
    return 'DO ' + tag + ' BEGIN\n' + body + '\nEND ' + tag + ';'


def migration_sql(plan, phase, runtime_roles=()):
    """Создать owner-only apply/verify/rollback; CAS не перезаписывает новые записи."""
    _require(phase in ('apply','verify','rollback'),'UNKNOWN_PHASE')
    _require(plan.get('planHash') == digest({k:v for k,v in plan.items() if k!='planHash'}),'PLAN_HASH_CHANGED')
    _require(plan['sourceHash']==digest(normalize(plan['before'])) and plan['postHash']==digest(normalize(plan['after'])),'SNAPSHOT_HASH_CHANGED')
    _require(all(re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*',role) for role in runtime_roles),'INVALID_RUNTIME_ROLE')
    prefix = [("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" if phase=='verify' else 'BEGIN;') + " SET LOCAL standard_conforming_strings=on; SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';",
        "SELECT pg_advisory_xact_lock(hashtextextended('brai:artifacts:owner-migration',0));",
        'LOCK TABLE '+','.join('artifacts.'+table for table,_,_ in TABLES.values())+(' IN ACCESS SHARE MODE;' if phase=='verify' else ' IN SHARE ROW EXCLUSIVE MODE;')]
    owner_check = "IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('artifacts','artifacts_brai_owner') AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner)<>current_user) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='artifacts_brai_owner' AND pg_get_userbyid(nspowner)<>current_user) THEN RAISE EXCEPTION 'ARTIFACT_OWNER_ROLE_REQUIRED'; END IF;"
    ddl = [f'CREATE SCHEMA IF NOT EXISTS {ARCHIVE};',f'REVOKE ALL ON SCHEMA {ARCHIVE} FROM PUBLIC;']
    for role in runtime_roles:
        ddl.append(f'REVOKE ALL ON SCHEMA {ARCHIVE} FROM "{role}";')
    ddl.append(f"CREATE TABLE IF NOT EXISTS {ARCHIVE}.runs(run_id text PRIMARY KEY,plan_hash text NOT NULL,source_hash text NOT NULL,post_hash text NOT NULL,accounts_hash text NOT NULL,provenance_hash text NOT NULL,software_hash text NOT NULL,state text NOT NULL,summary jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());")
    for name,(_,columns,keys) in TABLES.items():
        typed = ','.join(column+' '+kind for column,kind in columns)
        pk = ','.join(['run_id','phase',*keys])
        ddl.append(f'CREATE TABLE IF NOT EXISTS {ARCHIVE}.{name}_snapshots(run_id text NOT NULL,phase text NOT NULL,{typed},PRIMARY KEY({pk}));')
    run = _literal(plan['runId'])
    hash_literal = _literal(plan['planHash'])
    if phase == 'apply':
        work = [owner_check, f"IF EXISTS(SELECT 1 FROM {ARCHIVE}.runs WHERE run_id={run}) THEN",
            f"IF NOT EXISTS(SELECT 1 FROM {ARCHIVE}.runs WHERE run_id={run} AND plan_hash={hash_literal} AND state='applied') THEN RAISE EXCEPTION 'ARTIFACT_OWNER_RUN_CONFLICT'; END IF;",
            _assert_rows(plan,'after'), 'ELSE', _assert_rows(plan,'before',True)]
        for name,(_,columns,_) in TABLES.items():
            fields = ','.join(column for column,_ in columns)
            for snapshot_phase in ('before','after'):
                work.append(f'INSERT INTO {ARCHIVE}.{name}_snapshots(run_id,phase,{fields}) SELECT {run},{_literal(snapshot_phase)},{fields} FROM '+_rows(name,snapshot_phase,plan)+';')
        work.extend([_write_rows(plan,'after'),_assert_rows(plan,'after'),
            f"INSERT INTO {ARCHIVE}.runs(run_id,plan_hash,source_hash,post_hash,accounts_hash,provenance_hash,software_hash,state,summary) VALUES({run},{hash_literal},{_literal(plan['sourceHash'])},{_literal(plan['postHash'])},{_literal(plan['accountsHash'])},{_literal(plan['provenanceHash'])},{_literal(plan['ownerSoftwareHash'])},'applied',{_json_literal(plan['summary'])});",'END IF;'])
        ddl.append(f'REVOKE ALL ON ALL TABLES IN SCHEMA {ARCHIVE} FROM PUBLIC;')
        for role in runtime_roles:
            ddl.append(f'REVOKE ALL ON ALL TABLES IN SCHEMA {ARCHIVE} FROM "{role}";')
        prefix.extend(ddl)
    else:
        expected = 'applied' if phase=='verify' else 'applied'
        work = [owner_check,f"IF NOT EXISTS(SELECT 1 FROM {ARCHIVE}.runs WHERE run_id={run} AND plan_hash={hash_literal} AND state='{expected}') THEN RAISE EXCEPTION 'ARTIFACT_OWNER_RUN_CONFLICT'; END IF;",_assert_rows(plan,'after')]
        if phase == 'rollback':
            work.extend([_write_rows(plan,'before'),_assert_rows(plan,'before'),
                f"UPDATE {ARCHIVE}.runs SET state='rolled_back' WHERE run_id={run};"])
    prefix.append(_do('\n'.join(work)))
    if runtime_roles:
        roles = ','.join(_literal(role) for role in runtime_roles)
        prefix.append(_do(f"IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ({roles}) AND has_schema_privilege(rolname,{_literal(ARCHIVE)},'USAGE')) THEN RAISE EXCEPTION 'ARTIFACT_ARCHIVE_ACL_UNSAFE'; END IF;"))
    prefix.append("SELECT jsonb_build_object('state',"+_literal('verified' if phase=='verify' else 'applied' if phase=='apply' else 'rolled_back')+
        ",'runId',run_id,'sourceHash',source_hash,'postHash',post_hash,'accountsHash',accounts_hash,'provenanceHash',provenance_hash,'ownerSoftwareHash',software_hash,'planHash',plan_hash,'summary',summary) FROM "+ARCHIVE+".runs WHERE run_id="+run+'; COMMIT;')
    return '\n'.join(prefix)
