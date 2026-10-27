"""Plugin-owned SQLite state for Telegram Business Mode.

Two tables, both living in the plugin's own database file
(``<HERMES_HOME>/telegram-business/state.db``) — the plugin never touches
Hermes' core ``state.db`` schema:

  business_connections — one row per Telegram Business account that linked
    the bot via BotFather Business Mode. Updated by BusinessConnection
    updates (established / edited / ended).

  business_drafts — pending owner-approval drafts. Created when a customer
    messages a connected chat and the manager produces a candidate reply;
    resolved when the owner taps Send / Edit / Discard or when it expires.
"""

from __future__ import annotations

import json
import hashlib
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS business_connections (
    connection_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    owner_chat_id TEXT NOT NULL,
    can_reply INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    auto_draft INTEGER NOT NULL DEFAULT 1,
    paused_chats TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_biz_conn_owner
    ON business_connections(owner_user_id);

CREATE TABLE IF NOT EXISTS business_drafts (
    draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    owner_chat_id TEXT NOT NULL,
    customer_chat_id TEXT NOT NULL,
    customer_msg_id TEXT,
    customer_text TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    owner_message_id TEXT,
    final_sent_text TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_biz_drafts_conn_customer
    ON business_drafts(connection_id, customer_chat_id, status);
"""


class BusinessStateDB:
    """Thread-safe SQLite store for connections + drafts."""

    def __init__(self, db_path: Path) -> None:
        db_path = Path(db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS business_messages (
                    scope_id TEXT NOT NULL, message_id TEXT NOT NULL, scope TEXT NOT NULL,
                    text TEXT NOT NULL, actor TEXT NOT NULL, author_id TEXT NOT NULL,
                    origin TEXT NOT NULL, revision TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                    archive_pending INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    PRIMARY KEY(scope_id, message_id)
                );
            """)
            columns = {r[1] for r in self._conn.execute('PRAGMA table_info(business_drafts)')}
            if 'scope' not in columns:
                self._conn.execute("ALTER TABLE business_drafts ADD COLUMN scope TEXT")
            for column, migration in (
                ('send_token', 'ALTER TABLE business_drafts ADD COLUMN send_token TEXT'),
                ('send_action', 'ALTER TABLE business_drafts ADD COLUMN send_action TEXT'),
                ('source_version', 'ALTER TABLE business_drafts ADD COLUMN source_version TEXT'),
            ):
                if column not in columns:
                    self._conn.execute(migration)
            message_columns = {r[1] for r in self._conn.execute('PRAGMA table_info(business_messages)')}
            if 'event_at' not in message_columns:
                self._conn.execute('ALTER TABLE business_messages ADD COLUMN event_at REAL')
            self._conn.commit()
        self.home = db_path.resolve().parent.parent
        db_path.chmod(0o600)

    @staticmethod
    def _digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def business_scope(self, connection_id, chat_id):
        conn = self.get_telegram_business_connection(connection_id)
        if not conn or not conn.get('is_enabled') or not conn.get('owner_user_id') or not chat_id:
            raise ValueError('Business scope unavailable')
        return {'profile': str(self.home), 'owner': conn['owner_user_id'],
                'account': conn['owner_user_id'], 'connection': str(connection_id),
                'chat': str(chat_id), 'recipient': str(chat_id)}

    def _validate_scope(self, scope):
        if not isinstance(scope, dict) or scope != self.business_scope(scope.get('connection'), scope.get('chat')):
            raise ValueError('Business scope mismatch')
        return self._digest(scope)

    def record_business_message(self, scope, message_id, text, *, actor, author_id, origin, event_at=None, send_claim=None):
        if send_claim is None:
            scope_id = self._validate_scope(scope)
        else:
            # Only a durable, authenticated sending claim may record historical scope.
            claim = self.get_telegram_business_draft(send_claim['draft_id'])
            if (not claim or claim['status'] != 'sending' or not claim['send_token']
                    or claim['send_token'] != send_claim.get('send_token')
                    or json.loads(claim['scope']) != scope or str(author_id) != scope['owner']
                    or actor != ('owner' if claim['send_action'] == 'edit_send' else 'approved_ai')):
                raise ValueError('Invalid business send claim')
            scope_id = self._digest(scope)
        if not message_id or actor not in ('customer', 'owner', 'approved_ai'):
            raise ValueError('Invalid business message')
        from agent.memory_manager import _redact_for_provider
        text = _redact_for_provider(str(text))[:4000]
        revision = self._digest([scope_id, str(message_id), text, actor, str(author_id)])
        now = time.time()
        with self._lock, self._conn:
            self._conn.execute('BEGIN IMMEDIATE')
            prior = self._conn.execute('SELECT * FROM business_messages WHERE scope_id=? AND message_id=?',
                                      (scope_id, str(message_id))).fetchone()
            if prior and prior['deleted']:
                return False
            owner_enrichment = bool(prior and send_claim is not None and actor == 'owner'
                and prior['origin'] == 'telegram_bot_echo' and prior['text'] == text
                and prior['author_id'] == str(author_id))
            if prior and prior['event_at'] is not None:
                if owner_enrichment:
                    event_at = max(prior['event_at'], float(event_at) if event_at is not None else prior['event_at'])
                elif event_at is None or float(event_at) < prior['event_at']:
                    return False
                if send_claim is not None and prior['text'] != text and float(event_at) <= prior['event_at']:
                    return False  # An acknowledgement is not a new Telegram revision.
            # Unchanged echoes preserve verified provenance; only the authenticated
            # owner edit claim may enrich a bot echo that arrived before its ack.
            protected_echo = bool(prior and prior['text'] == text and (
                (prior['actor'] == 'approved_ai' and not owner_enrichment)
                or (prior['origin'] == 'owner_edit_send' and origin == 'telegram_bot_echo')))
            if prior and (prior['revision'] == revision or protected_echo):
                if event_at is not None and (prior['event_at'] is None or float(event_at) > prior['event_at']):
                    self._conn.execute('UPDATE business_messages SET event_at=? WHERE scope_id=? AND message_id=?',
                        (float(event_at),scope_id,str(message_id)))
                    self._conn.commit()
                return False
            self._conn.execute('''INSERT INTO business_messages
                (scope_id,message_id,scope,text,actor,author_id,origin,revision,created_at,updated_at,event_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,message_id) DO UPDATE SET
                text=excluded.text,actor=excluded.actor,author_id=excluded.author_id,origin=excluded.origin,
                revision=excluded.revision,archive_pending=1,updated_at=excluded.updated_at,event_at=excluded.event_at''',
                (scope_id,str(message_id),json.dumps(scope),text,actor,str(author_id),origin,revision,now,now,event_at))
            self._conn.execute("UPDATE business_drafts SET status='superseded',updated_at=? WHERE connection_id=? AND customer_chat_id=? AND status IN ('pending','awaiting_edit')",
                (now,scope['connection'],scope['chat']))
            self._conn.commit()
        return True

    def delete_business_messages(self, scope, message_ids):
        scope_id = self._validate_scope(scope)
        with self._lock:
            for message_id in message_ids:
                now = time.time()
                self._conn.execute('''INSERT INTO business_messages
                    (scope_id,message_id,scope,text,actor,author_id,origin,revision,deleted,archive_pending,created_at,updated_at)
                    VALUES (?,?,?,'','customer',?,'telegram_deleted',?,1,0,?,?)
                    ON CONFLICT(scope_id,message_id) DO UPDATE SET deleted=1,text='',archive_pending=0,updated_at=excluded.updated_at''',
                    (scope_id,str(message_id),json.dumps(scope),scope['recipient'],self._digest(['deleted',scope_id,str(message_id)]),now,now))
            self._conn.execute("UPDATE business_drafts SET status='superseded',updated_at=? WHERE connection_id=? AND customer_chat_id=? AND status IN ('pending','awaiting_edit')",
                (time.time(),scope['connection'],scope['chat']))
            self._conn.commit()

    def business_version(self, scope):
        scope_id = self._validate_scope(scope)
        with self._lock:
            rows = self._conn.execute('SELECT message_id,revision,deleted FROM business_messages WHERE scope_id=? ORDER BY message_id', (scope_id,)).fetchall()
        return self._digest([list(row) for row in rows])

    def pending_business_archives(self, *, after_rowid=0, through_rowid=None):
        with self._lock:
            return [dict(r) for r in self._conn.execute('''SELECT rowid AS archive_cursor,* FROM business_messages
                WHERE archive_pending=1 AND deleted=0 AND rowid>? AND (? IS NULL OR rowid<=?)
                ORDER BY rowid LIMIT 100''', (after_rowid,through_rowid,through_rowid))]

    def iter_pending_business_archives(self):
        # A finite high-water sweep with keyset pages: skipped rows remain durable,
        # and clearing earlier pages cannot shift an OFFSET past eligible rows.
        with self._lock:
            upper = self._conn.execute('SELECT COALESCE(MAX(rowid),0) FROM business_messages').fetchone()[0]
        cursor = 0
        while cursor < upper:
            page = self.pending_business_archives(after_rowid=cursor, through_rowid=upper)
            if not page:
                break
            cursor = page[-1]['archive_cursor']
            yield from page

    def mark_business_archived(self, scope, message_id, revision):
        scope_id = self._validate_scope(scope)
        with self._lock:
            self._conn.execute('UPDATE business_messages SET archive_pending=0 WHERE scope_id=? AND message_id=? AND revision=?',
                (scope_id,str(message_id),revision))
            self._conn.commit()

    def business_source_valid(self, scope, message_id, revision, author_id, actor, evidence=None):
        scope_id = self._validate_scope(scope)
        with self._lock:
            row = self._conn.execute('SELECT * FROM business_messages WHERE scope_id=? AND message_id=? AND deleted=0',
                (scope_id,str(message_id))).fetchone()
        return bool(row and row['revision'] == revision and row['author_id'] == author_id and row['actor'] == actor
                    and (evidence is None or (isinstance(evidence,str) and evidence and evidence in row['text'])))

    def business_history(self, scope, limit=20):
        scope_id = self._validate_scope(scope)
        with self._lock:
            rows = self._conn.execute('''SELECT * FROM business_messages WHERE scope_id=? AND deleted=0
                ORDER BY created_at DESC, message_id DESC LIMIT ?''', (scope_id, max(1, min(50, limit)))).fetchall()
        return [dict(row) for row in reversed(rows)]

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Connections
    # ------------------------------------------------------------------

    def upsert_telegram_business_connection(
        self,
        *,
        connection_id: str,
        owner_user_id: str,
        owner_chat_id: str,
        can_reply: bool,
        is_enabled: bool,
    ) -> None:
        """Insert or update a connection row.

        Preserves ``auto_draft`` and ``paused_chats`` across updates so the
        owner's preferences survive Telegram re-issuing the connection.
        """
        now = time.time()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO business_connections (
                    connection_id, owner_user_id, owner_chat_id,
                    can_reply, is_enabled, auto_draft, paused_chats,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1, '[]', ?, ?)
                ON CONFLICT(connection_id) DO UPDATE SET
                    owner_user_id = excluded.owner_user_id,
                    owner_chat_id = excluded.owner_chat_id,
                    can_reply = excluded.can_reply,
                    is_enabled = excluded.is_enabled,
                    updated_at = excluded.updated_at
                """,
                (
                    str(connection_id), str(owner_user_id), str(owner_chat_id),
                    1 if can_reply else 0, 1 if is_enabled else 0, now, now,
                ),
            )
            self._conn.commit()

    @staticmethod
    def _conn_row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        try:
            d["paused_chats"] = json.loads(d.get("paused_chats") or "[]")
        except (TypeError, ValueError):
            d["paused_chats"] = []
        d["can_reply"] = bool(d.get("can_reply"))
        d["is_enabled"] = bool(d.get("is_enabled"))
        d["auto_draft"] = bool(d.get("auto_draft", 1))
        return d

    def get_telegram_business_connection(
        self, connection_id: str
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM business_connections WHERE connection_id = ?",
                (str(connection_id),),
            ).fetchone()
        return self._conn_row_to_dict(row) if row is not None else None

    def list_telegram_business_connections(
        self, *, owner_user_id: Optional[str] = None, enabled_only: bool = True
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM business_connections"
        clauses: List[str] = []
        params: List[Any] = []
        if owner_user_id is not None:
            clauses.append("owner_user_id = ?")
            params.append(str(owner_user_id))
        if enabled_only:
            clauses.append("is_enabled = 1")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY updated_at DESC"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [self._conn_row_to_dict(r) for r in rows]

    def set_telegram_business_auto_draft(
        self, connection_id: str, *, auto_draft: bool
    ) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE business_connections SET auto_draft = ?, updated_at = ? "
                "WHERE connection_id = ?",
                (1 if auto_draft else 0, time.time(), str(connection_id)),
            )
            self._conn.commit()

    def set_telegram_business_paused_chats(
        self, connection_id: str, paused_chats: List[str]
    ) -> None:
        payload = json.dumps([str(c) for c in (paused_chats or [])])
        with self._lock:
            self._conn.execute(
                "UPDATE business_connections SET paused_chats = ?, updated_at = ? "
                "WHERE connection_id = ?",
                (payload, time.time(), str(connection_id)),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # Drafts
    # ------------------------------------------------------------------

    def create_telegram_business_draft(
        self,
        *,
        connection_id: str,
        owner_chat_id: str,
        customer_chat_id: str,
        customer_msg_id: Optional[str],
        customer_text: str,
        draft_text: str,
        ttl_seconds: float = 86400.0,
        expected_version: Optional[str] = None,
    ) -> int:
        """Insert a pending draft row and return its draft_id.

        Any prior pending drafts for the same (connection, customer_chat)
        are marked superseded so only one Send button is ever live per
        conversation.
        """
        now = time.time()
        with self._lock, self._conn:
            # Serialize source validation and insertion across SQLite instances.
            self._conn.execute('BEGIN IMMEDIATE')
            scope = self.business_scope(connection_id, customer_chat_id)
            version = self.business_version(scope)
            if expected_version is not None and expected_version != version:
                return 0
            connection = self.get_telegram_business_connection(connection_id)
            if not connection or str(owner_chat_id) != connection['owner_chat_id']:
                return 0
            from agent.memory_manager import _redact_for_provider
            customer_text = _redact_for_provider(customer_text)[:4000]
            draft_text = _redact_for_provider(draft_text)[:4000]
            self._conn.execute(
                "UPDATE business_drafts SET status = 'superseded', updated_at = ? "
                "WHERE connection_id = ? AND customer_chat_id = ? AND status IN ('pending','awaiting_edit')",
                (now, str(connection_id), str(customer_chat_id)),
            )
            cur = self._conn.execute(
                """
                INSERT INTO business_drafts (
                    connection_id, owner_chat_id, customer_chat_id,
                    customer_msg_id, customer_text, draft_text,
                    status, created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (
                    str(connection_id), str(owner_chat_id), str(customer_chat_id),
                    str(customer_msg_id) if customer_msg_id is not None else None,
                    customer_text, draft_text,
                    now, now, now + max(60.0, float(ttl_seconds)),
                ),
            )
            self._conn.execute('UPDATE business_drafts SET scope=?,source_version=? WHERE draft_id=?',
                (json.dumps(scope), version, cur.lastrowid))
            self._conn.commit()
            return int(cur.lastrowid or 0)

    def get_telegram_business_draft(self, draft_id: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM business_drafts WHERE draft_id = ?",
                (int(draft_id),),
            ).fetchone()
        return dict(row) if row is not None else None

    def set_telegram_business_draft_owner_message(
        self, draft_id: int, owner_message_id: str
    ) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE business_drafts SET owner_message_id = ?, updated_at = ? "
                "WHERE draft_id = ?",
                (str(owner_message_id), time.time(), int(draft_id)),
            )
            self._conn.commit()

    def claim_business_draft(self, draft_id, caller_user_id, action='send'):
        if not self.get_telegram_business_draft(draft_id):
            return None
        with self._lock, self._conn:
            self._conn.execute('BEGIN IMMEDIATE')
            stored = self._conn.execute('SELECT * FROM business_drafts WHERE draft_id=?', (draft_id,)).fetchone()
            row = dict(stored) if stored else None
            expected = 'awaiting_edit' if action == 'edit_send' else 'pending'
            if action not in ('send', 'edit', 'edit_send') or not row or row['status'] != expected or row['expires_at'] <= time.time():
                return None
            conn = self.get_telegram_business_connection(row['connection_id'])
            if (not conn or not conn['is_enabled'] or not conn['can_reply'] or not caller_user_id
                    or str(caller_user_id) != conn['owner_user_id'] or row['owner_chat_id'] != conn['owner_chat_id']):
                return None
            try:
                scope = json.loads(row['scope'] or 'null')
                self._validate_scope(scope)
                if not row['source_version'] or row['source_version'] != self.business_version(scope):
                    return None
            except (ValueError, TypeError):
                return None
            token = uuid.uuid4().hex if action != 'edit' else None
            claimed = self._conn.execute('''UPDATE business_drafts SET status=?,updated_at=?,send_token=?,send_action=?
                WHERE draft_id=? AND status=? AND expires_at>?
                AND EXISTS (SELECT 1 FROM business_connections c WHERE c.connection_id=business_drafts.connection_id
                    AND c.owner_user_id=? AND c.owner_chat_id=business_drafts.owner_chat_id AND c.is_enabled=1 AND c.can_reply=1)''',
                ('awaiting_edit' if action == 'edit' else 'sending', time.time(), token, action, draft_id, expected, time.time(), str(caller_user_id)))
            self._conn.commit()
            row['send_token'], row['send_action'] = token, action
            return row if claimed.rowcount == 1 else None

    def resolve_telegram_business_draft(
        self,
        draft_id: int,
        *,
        status: str,
        final_sent_text: Optional[str] = None,
        send_token: Optional[str] = None,
        caller_user_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Atomically mark a draft sent / edited / discarded / expired.

        Returns the prior row, or None if the draft no longer exists or was
        already resolved (so callbacks for stale buttons no-op safely).
        """
        if status not in {"sent", "edited", "discarded", "expired", "failed"}:
            raise ValueError(f"invalid business draft status: {status}")
        if final_sent_text is not None:
            from agent.memory_manager import _redact_for_provider
            final_sent_text = _redact_for_provider(final_sent_text)[:4000]
        now = time.time()
        with self._lock, self._conn:
            self._conn.execute('BEGIN IMMEDIATE')
            row = self._conn.execute(
                "SELECT * FROM business_drafts WHERE draft_id = ? AND status IN ('pending','sending','awaiting_edit')",
                (int(draft_id),),
            ).fetchone()
            if row is None:
                return None
            if status in {'sent', 'edited', 'failed'}:
                if row['status'] != 'sending' or not send_token or row['send_token'] != send_token:
                    return None
                if status != 'failed' and row['send_action'] != ('edit_send' if status == 'edited' else 'send'):
                    return None
            elif row['status'] == 'sending' or (status == 'discarded' and row['status'] != 'pending'):
                return None
            if status == 'discarded' and caller_user_id is not None:
                try:
                    scope = json.loads(row['scope'] or 'null')
                    self._validate_scope(scope)
                    if str(caller_user_id) != scope['owner']:
                        return None
                except (ValueError, TypeError):
                    return None
            changed = self._conn.execute(
                "UPDATE business_drafts SET status = ?, "
                "final_sent_text = COALESCE(?, final_sent_text), "
                "updated_at = ? WHERE draft_id = ? AND status = ?",
                (status, final_sent_text, now, int(draft_id), row['status']),
            )
            self._conn.commit()
            return dict(row) if changed.rowcount == 1 else None

    def get_pending_telegram_business_drafts_for_owner(
        self, owner_chat_id: str
    ) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM business_drafts WHERE owner_chat_id = ? "
                "AND status = 'pending' ORDER BY created_at ASC",
                (str(owner_chat_id),),
            ).fetchall()
        return [dict(r) for r in rows]

    def expire_telegram_business_drafts(self, *, now: Optional[float] = None) -> int:
        cutoff = now if now is not None else time.time()
        with self._lock:
            cur = self._conn.execute(
                "UPDATE business_drafts SET status = 'expired', updated_at = ? "
                "WHERE status IN ('pending','awaiting_edit') AND expires_at < ?",
                (cutoff, cutoff),
            )
            self._conn.commit()
            return int(cur.rowcount)
