# ABOUTME: Прототип устойчивого Telegram inbox в существующей SQLite IdentityJournal.
# ABOUTME: Не выполняет сетевые операции и не утверждает exactly-once передачу в worker.
import hashlib
import json
import os
import uuid

SCHEMA = '''CREATE TABLE IF NOT EXISTS release_inbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 bot_id TEXT NOT NULL, update_id TEXT NOT NULL,
 profile_id TEXT NOT NULL, user_id TEXT NOT NULL, uid INTEGER NOT NULL,
 actor_id TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL,
 chat_generation INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL,
 state TEXT NOT NULL, operation_id TEXT, receipt TEXT,
 UNIQUE(bot_id, update_id)
)'''


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def binding(profile):
    ident, owner, uid = profile['profileId'], profile['userId'], profile['uid']
    if not isinstance(ident, str) or str(uuid.UUID(ident)) != ident:
        raise ValueError('INVALID_PROFILE')
    if not isinstance(owner, str) or not owner or type(uid) is not int or uid <= 0:
        raise ValueError('INVALID_OWNER')
    return ident, owner, uid


def operation(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('INVALID_OPERATION')
    return value


def number(value, name):
    value = str(value)
    if not value.isascii() or not value.isdecimal() or int(value) <= 0:
        raise ValueError('INVALID_' + name)
    return value


class UpdateInbox:
    """Проверенные profile и Telegram actor задаёт вызывающий Auth owner."""
    def __init__(self, journal):
        self.journal = journal
        self.restartable = os.environ.get('BRAI_IDENTITY_INSTANCE') == 'dev'

    def install_v2(self, profile):
        """Add versioned metadata without rewriting or deleting legacy rows."""
        ident, owner, uid = binding(profile)
        db = self.journal.database(profile)
        created = False
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                db.execute(SCHEMA)
                db.execute(GATE_SCHEMA)
                tables = {row['name'] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('release_schema_owner','release_inbox_auth')")}
                if tables and tables != {'release_schema_owner','release_inbox_auth'}:
                    raise ValueError('INBOX_SCHEMA_CHANGED')
                db.execute('''CREATE TABLE IF NOT EXISTS release_schema_owner (
                    name TEXT PRIMARY KEY, version INTEGER NOT NULL,
                    profile_id TEXT NOT NULL, user_id TEXT NOT NULL, uid INTEGER NOT NULL)''')
                db.execute('''CREATE TABLE IF NOT EXISTS release_inbox_auth (
                    inbox_seq INTEGER PRIMARY KEY, author_id TEXT NOT NULL,
                    role TEXT NOT NULL, generation INTEGER NOT NULL)''')
                self._validate_v2_schema(db)
                row = db.execute("SELECT * FROM release_schema_owner WHERE name='telegram-inbox'").fetchone()
                if row is None:
                    db.execute("INSERT INTO release_schema_owner VALUES('telegram-inbox',2,?,?,?)", (ident,owner,uid))
                    created = True
                elif (row['version'],row['profile_id'],row['user_id'],row['uid']) != (2,ident,owner,uid):
                    raise ValueError('INBOX_SCHEMA_OWNER_CHANGED')
        finally:
            db.close()
        if created:
            self._sync_journal_directories(profile)

    @staticmethod
    def _validate_v2_schema(db):
        for table, expected in (('release_schema_owner', ['name','version','profile_id','user_id','uid']),
                                ('release_inbox_auth', ['inbox_seq','author_id','role','generation'])):
            if [row[1] for row in db.execute('PRAGMA table_info(' + table + ')')] != expected:
                raise ValueError('INBOX_SCHEMA_CHANGED')
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchone():
                raise ValueError('INBOX_SCHEMA_CHANGED')
        if db.execute('PRAGMA table_info(release_schema_owner)').fetchone()[5] != 1:
            raise ValueError('INBOX_SCHEMA_CHANGED')
        if db.execute('PRAGMA table_info(release_inbox_auth)').fetchone()[5] != 1:
            raise ValueError('INBOX_SCHEMA_CHANGED')

    @staticmethod
    def disposition_summary(db, profile):
        """Read-only summary on the caller's connection; never opens or changes a journal."""
        ident, owner, uid = binding(profile)
        UpdateInbox._validate_v2_schema(db)
        row = db.execute("SELECT version,profile_id,user_id,uid FROM release_schema_owner WHERE name='telegram-inbox'").fetchone()
        if row is None or tuple(row) != (2,ident,owner,uid):
            raise ValueError('INBOX_SCHEMA_OWNER_CHANGED')
        if db.execute('SELECT 1 FROM release_inbox WHERE profile_id<>? OR user_id<>? OR uid<>? LIMIT 1',
                      (ident,owner,uid)).fetchone():
            raise ValueError('INBOX_SCHEMA_OWNER_CHANGED')
        if db.execute('''SELECT 1 FROM release_inbox_auth a LEFT JOIN release_inbox i ON i.seq=a.inbox_seq
                         WHERE i.seq IS NULL OR a.author_id='' OR a.role='' OR a.generation<0 LIMIT 1''').fetchone():
            raise ValueError('INBOX_SCHEMA_CHANGED')
        allowed = ('captured','held','handing_off','unknown','blocked','native_duplicate','accepted','handled')
        counts = {key:0 for key in allowed}
        for state, count in db.execute('SELECT state,count(*) FROM release_inbox GROUP BY state'):
            if state not in counts:
                raise ValueError('INBOX_STATE_UNKNOWN')
            counts[state] = count
        unbound = db.execute('''SELECT count(*) FROM release_inbox AS i
            LEFT JOIN release_inbox_auth AS a ON a.inbox_seq=i.seq WHERE a.inbox_seq IS NULL''').fetchone()[0]
        unfinished = sum(counts[key] for key in ('captured','held','handing_off','unknown','blocked','native_duplicate'))
        gates = db.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='release_profile_gates'").fetchone()[0]
        if gates:
            validate_gate_schema(db)
            states = {'arming','ready','reopening','resuming','unknown','busy','resumed'}
            gate_states = [row[0] for row in db.execute('SELECT state FROM release_profile_gates')]
            if any(state not in states for state in gate_states):
                raise ValueError('PROFILE_GATE_STATE_UNKNOWN')
            active_gates = sum(state not in ('busy','resumed') for state in gate_states)
        else:
            active_gates = 0
        return {'schemaVersion':2,'counts':counts,'unbound':unbound,
                'activeGates':active_gates,'rollbackSafe':unfinished == 0 and active_gates == 0}

    def _open(self, profile):
        binding(profile)
        db = self.journal.database(profile)
        try:
            # Проверить имеющуюся схему, а не доверять одноимённой чужой таблице.
            db.execute(SCHEMA)
            names = [row['name'] for row in db.execute('PRAGMA table_info(release_inbox)')]
            if names != ['seq', 'bot_id', 'update_id', 'profile_id', 'user_id', 'uid',
                         'actor_id', 'chat', 'thread', 'chat_generation', 'payload', 'digest',
                         'state', 'operation_id', 'receipt']:
                raise ValueError('INBOX_SCHEMA_CHANGED')
            indexes = list(db.execute('PRAGMA index_list(release_inbox)'))
            if not any(row['unique'] and [col['name'] for col in db.execute(
                    'PRAGMA index_info(' + json.dumps(row['name']) + ')')] == ['bot_id', 'update_id']
                    for row in indexes):
                raise ValueError('INBOX_SCHEMA_CHANGED')
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='release_inbox'").fetchone():
                raise ValueError('INBOX_SCHEMA_CHANGED')
            if db.execute('PRAGMA synchronous').fetchone()[0] != 2:
                raise ValueError('INBOX_DURABILITY_UNAVAILABLE')
            return db
        except BaseException:
            db.close()
            raise

    @staticmethod
    def _input(update):
        update_id = update.update_id
        if type(update_id) is not int or update_id < 0:
            raise ValueError('INVALID_UPDATE')
        actor = number(getattr(getattr(update, 'effective_user', None), 'id', None), 'ACTOR')
        chat_obj = getattr(update, 'effective_chat', None)
        chat = number(getattr(chat_obj, 'id', None) if chat_obj is not None else actor, 'CHAT')
        message = getattr(update, 'effective_message', None)
        thread = str(getattr(message, 'message_thread_id', None) or '')
        if thread == '1': thread = ''
        if thread and (not thread.isascii() or not thread.isdecimal()):
            raise ValueError('INVALID_THREAD')
        payload = canonical(update.to_dict())
        data = json.loads(payload)
        if type(data.get('update_id')) is not int or data['update_id'] != update_id:
            raise ValueError('UPDATE_ID_CHANGED')
        return str(update_id), actor, chat, thread, payload, hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _state(db, chat, thread):
        return db.execute('SELECT paused,generation FROM chat_pauses WHERE chat=? AND thread=?', (chat,thread)).fetchone()

    def _sync_journal_directories(self, profile):
        # SQLite FULL commits data/WAL; directory entries also need durable creation.
        root = self.journal.root
        for directory in (root / profile['profileId'], root, root.parent):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def capture(self, profile, update, bot_id):
        """Commit и directory fsync до возврата пачки; duplicate идемпотентен."""
        ident, owner, uid = binding(profile)
        bot_id = number(bot_id, 'BOT')
        update_id, actor, chat, thread, payload, digest = self._input(update)
        author = number(profile.get('authorTelegramId'), 'AUTHOR')
        role, auth_generation = profile.get('role'), profile.get('generation')
        if (str(profile.get('telegramId')) != actor or not isinstance(role, str) or not role
                or type(auth_generation) is not int or auth_generation < 0):
            raise ValueError('INBOX_AUTH_UNAVAILABLE')
        self.install_v2(profile)
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                existing = db.execute('SELECT * FROM release_inbox WHERE bot_id=? AND update_id=?',
                                      (bot_id, update_id)).fetchone()
                if existing:
                    auth = db.execute('SELECT author_id,role,generation FROM release_inbox_auth WHERE inbox_seq=?',
                                      (existing['seq'],)).fetchone()
                    if auth is None:
                        raise ValueError('INBOX_AUTH_UNAVAILABLE')
                    if tuple(auth) != (author,role,auth_generation):
                        raise ValueError('INBOX_IDENTITY_CONFLICT')
                    if (existing['digest'], existing['payload'], existing['profile_id'], existing['user_id'],
                        existing['uid'], existing['actor_id'], existing['chat'], existing['thread']) != (
                            digest,payload,ident,owner,uid,actor,chat,thread):
                        raise ValueError('INBOX_IDENTITY_CONFLICT')
                    result = {'seq': existing['seq'], 'state': existing['state'], 'digest': digest}
                else:
                    state = self._state(db, chat, thread)
                    generation = state['generation'] if state else 0
                    cur = db.execute("""INSERT INTO release_inbox
                        (bot_id,update_id,profile_id,user_id,uid,actor_id,chat,thread,chat_generation,payload,digest,state)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,'captured')""",
                        (bot_id,update_id,ident,owner,uid,actor,chat,thread,generation,payload,digest))
                    db.execute('INSERT INTO release_inbox_auth VALUES(?,?,?,?)',
                               (cur.lastrowid,author,role,auth_generation))
                    result = {'seq': cur.lastrowid, 'state':'captured', 'digest':digest}
        finally:
            db.close()
        self._sync_journal_directories(profile)
        return result

    def capture_batch(self, items, bot_id):
        """Разные SQLite не атомарны вместе: ошибка прерывает возврат всей пачки."""
        return [self.capture(profile, update, bot_id) for profile, update in items]

    @staticmethod
    def _find(db, profile, bot_id, update_id):
        ident, owner, uid = binding(profile)
        row = db.execute('SELECT * FROM release_inbox WHERE bot_id=? AND update_id=?',
                         (number(bot_id,'BOT'),str(update_id))).fetchone()
        if row is None:
            raise ValueError('INBOX_NOT_FOUND')
        if (row['profile_id'],row['user_id'],row['uid']) != (ident,owner,uid):
            raise PermissionError('INBOX_OWNER_CHANGED')
        return row

    def disposition(self, profile, bot_id, update_id, state, *, operation_id=None):
        """held и native_duplicate не утверждают выполнение worker."""
        if state not in ('held','native_duplicate'):
            raise ValueError('INVALID_DISPOSITION')
        op = operation(operation_id) if state == 'held' else None
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = self._find(db,profile,bot_id,update_id)
                if not (row['state'] == state and row['operation_id'] == op):
                    if row['state'] != 'captured':
                        raise ValueError('INBOX_STATE_CHANGED')
                    db.execute('UPDATE release_inbox SET state=?,operation_id=? WHERE seq=?',(state,op,row['seq']))
        finally: db.close()
        self._sync_journal_directories(profile)
        return state

    def claim_for_delivery(self, profile, bot_id, update_id, *, operation_id=None):
        """Перед эффектом durable captured/held→handing_off; неизвестное не повторять."""
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = self._find(db,profile,bot_id,update_id)
                if row['state'] not in ('captured','held'):
                    raise ValueError('INBOX_NOT_REPLAYABLE')
                if db.execute('SELECT 1 FROM release_inbox_auth WHERE inbox_seq=?', (row['seq'],)).fetchone() is None:
                    raise ValueError('INBOX_AUTH_UNAVAILABLE')
                if row['state'] == 'held' and row['operation_id'] != operation(operation_id):
                    raise PermissionError('INBOX_OPERATION_CHANGED')
                blocked_states = ("('held','handing_off','unknown','blocked')" if row['state'] == 'held'
                                  else "('unknown','blocked')")
                if not self.restartable and db.execute("SELECT 1 FROM release_inbox WHERE seq<? AND state IN " + blocked_states + " LIMIT 1", (row['seq'],)).fetchone():
                    raise ValueError('INBOX_ORDER_BLOCKED')
                current = self._state(db,row['chat'],row['thread'])
                if current and (current['paused'] or current['generation'] != row['chat_generation']):
                    raise PermissionError('INBOX_CONSENT_CHANGED')
                db.execute("UPDATE release_inbox SET state='handing_off' WHERE seq=?", (row['seq'],))
                result = {'seq':row['seq'],'update':json.loads(row['payload']),
                          'digest':row['digest'],'generation':row['chat_generation']}
        finally: db.close()
        self._sync_journal_directories(profile)
        return result

    def markblocked(self, profile, bot_id, update_id):
        """Не отправлять прежний input другой Auth-связи; сохранить его для оператора."""
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = self._find(db, profile, bot_id, update_id)
                if row['state'] not in ('captured', 'held', 'handing_off', 'blocked'):
                    raise ValueError('INBOX_STATE_CHANGED')
                db.execute("UPDATE release_inbox SET state='blocked' WHERE seq=?", (row['seq'],))
        finally:
            db.close()
        self._sync_journal_directories(profile)
        return 'blocked'

    def markaccepted(self, profile, bot_id, update_id, receipt):
        """Сохранить подтверждённый receipt; это не proof exactly-once всей цепочки."""
        if not isinstance(receipt,dict) or receipt.get('accepted') is not True:
            raise ValueError('INVALID_RECEIPT')
        value = canonical(receipt)
        return self._finish(profile,bot_id,update_id,'accepted',value)

    def markhandled(self, profile, bot_id, update_id):
        """Зафиксировать завершённый ingress-only outcome без утверждения worker effect."""
        return self._finish(profile, bot_id, update_id, 'handled', None)

    def unsettled(self, profile):
        """Ошибки/неизвестные outcomes блокируют переключение и не исчезают из proof."""
        ident, owner, uid = binding(profile)
        db = self._open(profile)
        try:
            rows = db.execute("SELECT i.seq,i.profile_id,i.user_id,i.uid,i.state,i.operation_id,i.bot_id,i.update_id, "
                              "EXISTS(SELECT 1 FROM release_inbox_auth a WHERE a.inbox_seq=i.seq) AS bound "
                              "FROM release_inbox i WHERE i.state IN ('captured','held','handing_off','unknown','blocked','native_duplicate') ORDER BY i.seq").fetchall()
            if any((row['profile_id'],row['user_id'],row['uid']) != (ident,owner,uid) for row in rows):
                raise PermissionError('INBOX_OWNER_CHANGED')
            return [{'seq': row['seq'], 'state': row['state'], 'operationId': row['operation_id'],
                     'botId': row['bot_id'], 'updateId': row['update_id'], 'bound':bool(row['bound'])} for row in rows]
        finally:
            db.close()

    def prepare_restart(self, profile):
        """DEV: сохранить неизвестные исходы, открыть только ещё не переданные входы."""
        if not self.restartable:
            raise PermissionError('DEV_RESTART_ONLY')
        self.install_v2(profile)
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                db.execute("UPDATE release_inbox SET state='unknown' WHERE state='handing_off'")
                db.execute("UPDATE release_inbox SET state='captured',operation_id=NULL WHERE state='held'")
        finally:
            db.close()
        self._sync_journal_directories(profile)

    def markunknown(self, profile, bot_id, update_id):
        return self._finish(profile,bot_id,update_id,'unknown',None)

    def _finish(self, profile, bot_id, update_id, state, receipt):
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = self._find(db,profile,bot_id,update_id)
                if not (row['state'] == state and row['receipt'] == receipt):
                    if row['state'] != 'handing_off': raise ValueError('INBOX_STATE_CHANGED')
                    db.execute('UPDATE release_inbox SET state=?,receipt=? WHERE seq=?',(state,receipt,row['seq']))
        finally: db.close()
        self._sync_journal_directories(profile)
        return state

    def observe(self, profile, bot_id, update_id):
        db = self._open(profile)
        try:
            row = self._find(db,profile,bot_id,update_id)
            return {key:row[key] for key in ('seq','bot_id','update_id','profile_id','user_id','uid',
                    'actor_id','chat','thread','chat_generation','digest','state','operation_id','receipt')}
        finally: db.close()

    def held(self, profile, operation_id):
        """Только held, в порядке записи; handing_off/unknown не предлагаются повторно."""
        op = operation(operation_id)
        ident,owner,uid = binding(profile)
        db = self._open(profile)
        try:
            rows = db.execute("SELECT seq,bot_id,update_id,actor_id,payload,digest,profile_id,user_id,uid,state,operation_id FROM release_inbox WHERE state IN ('held','handing_off','unknown','blocked','native_duplicate') ORDER BY seq").fetchall()
            if any((r['profile_id'],r['user_id'],r['uid']) != (ident,owner,uid) for r in rows):
                raise PermissionError('INBOX_OWNER_CHANGED')
            if any(r['state'] != 'held' or r['operation_id'] != op for r in rows):
                raise ValueError('INBOX_UNRESOLVED_HANDOFF')
            auth = {r['inbox_seq']:r for r in db.execute('SELECT * FROM release_inbox_auth')}
            if any(r['seq'] not in auth for r in rows):
                raise ValueError('INBOX_AUTH_UNAVAILABLE')
            return [{'seq':r['seq'],'bot_id':r['bot_id'],'update_id':r['update_id'],
                     'actorId':r['actor_id'],'authorId':auth[r['seq']]['author_id'],
                     'authRole':auth[r['seq']]['role'],'authGeneration':auth[r['seq']]['generation'],
                     'update':json.loads(r['payload']),'digest':r['digest']} for r in rows]
        finally: db.close()

GATE_SCHEMA = '''CREATE TABLE IF NOT EXISTS release_profile_gates (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 profile_id TEXT NOT NULL, user_id TEXT NOT NULL, uid INTEGER NOT NULL,
 target_hash TEXT NOT NULL, worker_pid INTEGER NOT NULL, worker_start TEXT NOT NULL,
 boot_id TEXT NOT NULL, state TEXT NOT NULL,
 replacement_pid INTEGER, replacement_start TEXT,
 UNIQUE(operation_id, attempt_id)
)'''


def validate_gate_schema(db):
    expected = [('seq','INTEGER',0,1),('operation_id','TEXT',1,0),('attempt_id','TEXT',1,0),
                ('profile_id','TEXT',1,0),('user_id','TEXT',1,0),('uid','INTEGER',1,0),
                ('target_hash','TEXT',1,0),('worker_pid','INTEGER',1,0),('worker_start','TEXT',1,0),
                ('boot_id','TEXT',1,0),('state','TEXT',1,0),('replacement_pid','INTEGER',0,0),
                ('replacement_start','TEXT',0,0)]
    info = list(db.execute('PRAGMA table_info(release_profile_gates)'))
    if [(r[1],r[2].upper(),r[3],r[5]) for r in info] != expected:
        raise ValueError('PROFILE_GATE_SCHEMA_CHANGED')
    indexes = list(db.execute('PRAGMA index_list(release_profile_gates)'))
    if not any(row[2] and [column[2] for column in db.execute(
            'PRAGMA index_info(' + json.dumps(row[1]) + ')')] == ['operation_id','attempt_id']
            and not row[4] for row in indexes):
        raise ValueError('PROFILE_GATE_SCHEMA_CHANGED')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='release_profile_gates'").fetchone():
        raise ValueError('PROFILE_GATE_SCHEMA_CHANGED')


class ProfileGateStore:
    """Root-bound operation receipts внутри того же защищённого журнала профиля."""
    def __init__(self, inbox):
        self.inbox = inbox

    def _open(self, profile):
        self.inbox.install_v2(profile)
        db = self.inbox._open(profile)
        try:
            db.execute(GATE_SCHEMA)
            validate_gate_schema(db)
            return db
        except BaseException:
            db.close()
            raise

    @staticmethod
    def _binding(profile, request, boot_id):
        import re
        ident, owner, uid = binding(profile)
        operation_id = operation(request['operationId'])
        attempt_id = operation(request['attemptId'])
        if request['profileId'] != ident:
            raise ValueError('PROFILE_GATE_BINDING_CHANGED')
        target = request['targetPayloadHash']
        pid, start = request['workerPid'], request['workerStartTime']
        if (not isinstance(target, str) or re.fullmatch('[a-f0-9]{64}', target) is None
                or type(pid) is not int or pid <= 0 or not isinstance(start, str)
                or not start.isascii() or not start.isdecimal()):
            raise ValueError('PROFILE_GATE_BINDING_CHANGED')
        if not isinstance(boot_id, str) or str(uuid.UUID(boot_id)) != boot_id:
            raise ValueError('PROFILE_GATE_BOOT_INVALID')
        return (operation_id,attempt_id,ident,owner,uid,target,pid,start,boot_id)

    def begin(self, profile, request, boot_id):
        """Создать durable arming; предыдущая незавершённая попытка не вытесняется."""
        values = self._binding(profile,request,boot_id)
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                existing = db.execute('SELECT * FROM release_profile_gates WHERE operation_id=? AND attempt_id=?', values[:2]).fetchone()
                if existing:
                    latest = db.execute('SELECT seq FROM release_profile_gates ORDER BY seq DESC LIMIT 1').fetchone()
                    if latest is None or existing['seq'] != latest['seq']:
                        raise ValueError('PROFILE_GATE_ATTEMPT_SUPERSEDED')
                    got = tuple(existing[key] for key in ('operation_id','attempt_id','profile_id','user_id','uid','target_hash','worker_pid','worker_start','boot_id'))
                    if got != values:
                        raise ValueError('PROFILE_GATE_BINDING_CHANGED')
                    result = dict(existing)
                else:
                    latest = db.execute('SELECT * FROM release_profile_gates ORDER BY seq DESC LIMIT 1').fetchone()
                    if latest and latest['state'] not in ('busy','resumed'):
                        raise ValueError('PROFILE_GATE_UNFINISHED')
                    db.execute('''INSERT INTO release_profile_gates
                        (operation_id,attempt_id,profile_id,user_id,uid,target_hash,worker_pid,worker_start,boot_id,state)
                        VALUES(?,?,?,?,?,?,?,?,?,'arming')''',values)
                    result = dict(db.execute('SELECT * FROM release_profile_gates WHERE operation_id=? AND attempt_id=?',values[:2]).fetchone())
        finally:
            db.close()
        self.inbox._sync_journal_directories(profile)
        return result

    def transition(self, profile, request, boot_id, expected, state, *, replacement_pid=None, replacement_start=None):
        """Сохранить exact CAS и замещение процесса до подтверждённого ответа."""
        values = self._binding(profile,request,boot_id)
        allowed = {'arming': {'ready','reopening','unknown'}, 'ready': {'resuming','unknown'},
                   'reopening': {'busy','unknown'}, 'resuming': {'resumed','unknown'}}
        if state not in allowed.get(expected, set()):
            raise ValueError('PROFILE_GATE_TRANSITION_INVALID')
        if state in ('resuming', 'resumed') and (replacement_pid is not None or replacement_start is not None) and (type(replacement_pid) is not int or replacement_pid <= 0
                or not isinstance(replacement_start,str) or not replacement_start.isascii()
                or not replacement_start.isdecimal()):
            raise ValueError('PROFILE_GATE_REPLACEMENT_INVALID')
        if state == 'resumed' and replacement_pid is None:
            raise ValueError('PROFILE_GATE_REPLACEMENT_INVALID')
        if state not in ('resuming', 'resumed') and (replacement_pid is not None or replacement_start is not None):
            raise ValueError('PROFILE_GATE_REPLACEMENT_INVALID')
        db = self._open(profile)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT * FROM release_profile_gates WHERE operation_id=? AND attempt_id=?',values[:2]).fetchone()
                latest = db.execute('SELECT seq FROM release_profile_gates ORDER BY seq DESC LIMIT 1').fetchone()
                if not row or not latest or row['seq'] != latest['seq']:
                    raise ValueError('PROFILE_GATE_ATTEMPT_SUPERSEDED')
                got = tuple(row[key] for key in ('operation_id','attempt_id','profile_id','user_id','uid','target_hash','worker_pid','worker_start','boot_id'))
                if got != values:
                    raise ValueError('PROFILE_GATE_BINDING_CHANGED')
                if row['state'] == state:
                    if (row['replacement_pid'],row['replacement_start']) != (replacement_pid,replacement_start):
                        raise ValueError('PROFILE_GATE_REPLACEMENT_CHANGED')
                elif row['state'] != expected:
                    raise ValueError('PROFILE_GATE_STATE_CHANGED')
                else:
                    if expected == 'resuming' and state == 'resumed' and row['replacement_pid'] is not None and (
                            row['replacement_pid'], row['replacement_start']) != (replacement_pid, replacement_start):
                        raise ValueError('PROFILE_GATE_REPLACEMENT_CHANGED')
                    db.execute('UPDATE release_profile_gates SET state=?,replacement_pid=?,replacement_start=? WHERE seq=?',
                               (state,replacement_pid,replacement_start,row['seq']))
                result = dict(db.execute('SELECT * FROM release_profile_gates WHERE seq=?',(row['seq'],)).fetchone())
        finally:
            db.close()
        self.inbox._sync_journal_directories(profile)
        return result

    def current(self, profile, boot_id):
        """После restart неизвестный boot/binding удерживается, а не открывается."""
        ident,owner,uid = binding(profile)
        if not isinstance(boot_id,str) or str(uuid.UUID(boot_id)) != boot_id:
            raise ValueError('PROFILE_GATE_BOOT_INVALID')
        db = self._open(profile)
        try:
            row = db.execute('SELECT * FROM release_profile_gates ORDER BY seq DESC LIMIT 1').fetchone()
            if row is None:
                return None
            result = dict(row)
            if ((row['profile_id'],row['user_id'],row['uid']) != (ident,owner,uid)
                    or row['boot_id'] != boot_id):
                result['state'] = 'unknown'
            return result
        finally:
            db.close()

    def status(self, profile, request, boot_id):
        """Исторический receipt не заменяет проверку текущего peer у вызывающей стороны."""
        values = self._binding(profile,request,boot_id)
        db = self._open(profile)
        try:
            row = db.execute('SELECT * FROM release_profile_gates WHERE operation_id=? AND attempt_id=?', values[:2]).fetchone()
            if row is None:
                return None
            got = tuple(row[key] for key in ('operation_id','attempt_id','profile_id','user_id','uid','target_hash','worker_pid','worker_start','boot_id'))
            if got != values:
                raise ValueError('PROFILE_GATE_BINDING_CHANGED')
            result = dict(row)
            latest = db.execute('SELECT seq FROM release_profile_gates ORDER BY seq DESC LIMIT 1').fetchone()
            if latest is None or row['seq'] != latest['seq']:
                result['state'] = 'unknown'
            return result
        finally:
            db.close()
