# ABOUTME: Устойчиво закрепляет исходную Auth-привязку до подтверждения Telegram.
# ABOUTME: Хранится в существующем каталоге IdentityJournal; не запускает обработчики.
import hashlib
import json

from .update_inbox import canonical, number

TRANSPORT_PROFILE = {'profileId':'00000000-0000-0000-0000-000000000000'}
TRANSPORT_SCHEMA = '''CREATE TABLE IF NOT EXISTS release_transport (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 bot_id TEXT NOT NULL, update_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 payload TEXT NOT NULL, digest TEXT NOT NULL, binding TEXT NOT NULL,
 state TEXT NOT NULL, UNIQUE(bot_id,update_id)
)'''


class TransportInbox:
    def __init__(self, journal):
        self.journal = journal

    def _open(self):
        db = self.journal.database(TRANSPORT_PROFILE)
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('release_transport','release_transport_owner')")}
                if names and names != {'release_transport','release_transport_owner'}:
                    raise ValueError('TRANSPORT_SCHEMA_CHANGED')
                db.execute(TRANSPORT_SCHEMA)
                db.execute('''CREATE TABLE IF NOT EXISTS release_transport_owner (
                    name TEXT PRIMARY KEY, version INTEGER NOT NULL)''')
                if not names:
                    db.execute("INSERT INTO release_transport_owner VALUES('telegram-transport',2)")
                owners = [tuple(row) for row in db.execute('SELECT name,version FROM release_transport_owner')]
                if owners != [('telegram-transport',2)]:
                    raise ValueError('TRANSPORT_SCHEMA_OWNER_CHANGED')
            expected = [('seq','INTEGER',0,1), *[(key,'TEXT',1,0) for key in
                        ('bot_id','update_id','actor_id','payload','digest','binding','state')]]
            if [(row[1],row[2].upper(),row[3],row[5]) for row in db.execute(
                    'PRAGMA table_info(release_transport)')] != expected:
                raise ValueError('TRANSPORT_SCHEMA_CHANGED')
            owner_schema = [(row[1],row[2].upper(),row[3],row[5]) for row in db.execute(
                'PRAGMA table_info(release_transport_owner)')]
            if owner_schema != [('name','TEXT',0,1),('version','INTEGER',1,0)]:
                raise ValueError('TRANSPORT_SCHEMA_CHANGED')
            indexes = list(db.execute('PRAGMA index_list(release_transport)'))
            if not any(row[2] and not row[4] and [column[2] for column in db.execute(
                    'PRAGMA index_info(' + json.dumps(row[1]) + ')')] == ['bot_id','update_id'] for row in indexes):
                raise ValueError('TRANSPORT_SCHEMA_CHANGED')
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('release_transport','release_transport_owner')").fetchone():
                raise ValueError('TRANSPORT_SCHEMA_CHANGED')
            states = ('captured','handing_off','accepted','handled','blocked','unknown','rejected','ignored')
            if any(row[0] not in states for row in db.execute('SELECT DISTINCT state FROM release_transport')):
                raise ValueError('TRANSPORT_STATE_INVALID')
            if db.execute('PRAGMA synchronous').fetchone()[0] != 2:
                raise ValueError('TRANSPORT_DURABILITY_UNAVAILABLE')
            return db
        except BaseException:
            db.close()
            raise

    def _sync(self):
        import os
        for directory in (self.journal.root / TRANSPORT_PROFILE['profileId'],self.journal.root,self.journal.root.parent):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    @staticmethod
    def _binding(snapshot):
        state = snapshot.get('state') if isinstance(snapshot,dict) else None
        if state not in ('known','unregistered','forbidden','outside'):
            raise ValueError('TRANSPORT_BINDING_INVALID')
        if state != 'known':
            return {'state':state}
        profile = snapshot.get('profile')
        keys = ('uid','profileId','userId','telegramId','authorTelegramId','role','generation')
        if not isinstance(profile,dict) or any(key not in profile for key in keys):
            raise ValueError('TRANSPORT_BINDING_INVALID')
        if profile['profileId'] == TRANSPORT_PROFILE['profileId']:
            raise ValueError('TRANSPORT_PROFILE_COLLISION')
        return {'state':'known','profile':{key:profile[key] for key in keys}}

    def capture_batch(self, staged, bot_id):
        bot_id = number(bot_id,'BOT')
        db = self._open()
        try:
            results = []
            with db:
                db.execute('BEGIN IMMEDIATE')
                for update,snapshot in staged:
                    update_id = getattr(update,'update_id',None)
                    if type(update_id) is not int or update_id < 0:
                        raise ValueError('TRANSPORT_UPDATE_INVALID')
                    user = getattr(update,'effective_user',None)
                    actor = str(getattr(user,'id','') or '')
                    payload = canonical(update.to_dict())
                    digest = hashlib.sha256(payload.encode()).hexdigest()
                    bound = canonical(self._binding(snapshot))
                    row = db.execute('SELECT * FROM release_transport WHERE bot_id=? AND update_id=?',
                                     (bot_id,str(update_id))).fetchone()
                    if row is None:
                        initial = {'outside':'ignored','forbidden':'rejected'}.get(snapshot['state'],'captured')
                        db.execute('''INSERT INTO release_transport
                            (bot_id,update_id,actor_id,payload,digest,binding,state) VALUES(?,?,?,?,?,?,?)''',
                            (bot_id,str(update_id),actor,payload,digest,bound,initial))
                        results.append(initial)
                    elif (row['actor_id'],row['payload'],row['digest'],row['binding']) != (actor,payload,digest,bound):
                        if row['state'] not in ('accepted','handled','ignored','rejected'):
                            db.execute("UPDATE release_transport SET state='blocked' WHERE seq=?",(row['seq'],))
                        results.append('binding_changed')
                    else:
                        results.append(row['state'])
        finally:
            db.close()
        self._sync()
        return results

    def transition(self, bot_id, update_id, expected, state):
        allowed = {'captured':{'handing_off','blocked'}, 'handing_off':{'accepted','handled','unknown','blocked'}}
        if state not in allowed.get(expected,set()):
            raise ValueError('TRANSPORT_TRANSITION_INVALID')
        db = self._open()
        try:
            with db:
                db.execute('BEGIN IMMEDIATE')
                row=db.execute('SELECT * FROM release_transport WHERE bot_id=? AND update_id=?',
                               (number(bot_id,'BOT'),str(update_id))).fetchone()
                if row is None or row['state'] not in (expected,state):
                    raise ValueError('TRANSPORT_STATE_CHANGED')
                if row['state'] == expected:
                    db.execute('UPDATE release_transport SET state=? WHERE seq=?',(state,row['seq']))
        finally:
            db.close()
        self._sync()

    def pending(self):
        db = self._open()
        try:
            rows = [dict(row) for row in db.execute(
                "SELECT * FROM release_transport WHERE state NOT IN ('accepted','handled','ignored','rejected') ORDER BY seq")]
            for row in rows:
                payload = json.loads(row['payload'])
                binding = json.loads(row['binding'])
                if (not isinstance(payload,dict) or type(payload.get('update_id')) is not int
                        or str(payload['update_id']) != row['update_id'] or canonical(payload) != row['payload']
                        or hashlib.sha256(row['payload'].encode()).hexdigest() != row['digest']
                        or canonical(self._binding(binding)) != row['binding']):
                    raise ValueError('TRANSPORT_RECORD_CHANGED')
            return rows
        finally:
            db.close()

    def blocked_for(self, uid):
        if type(uid) is not int or uid <= 0:
            raise ValueError('TRANSPORT_BINDING_INVALID')
        for row in self.pending():
            if row['state'] not in ('blocked','unknown'):
                continue
            binding = json.loads(row['binding'])
            profile = binding.get('profile') if isinstance(binding,dict) else None
            if isinstance(profile,dict) and profile.get('uid') == uid:
                return True
        return False

    def observe(self, bot_id, update_id):
        db = self._open()
        try:
            row = db.execute('SELECT * FROM release_transport WHERE bot_id=? AND update_id=?',
                             (number(bot_id,'BOT'),str(update_id))).fetchone()
            if row is None:
                raise ValueError('TRANSPORT_NOT_FOUND')
            return dict(row)
        finally:
            db.close()
