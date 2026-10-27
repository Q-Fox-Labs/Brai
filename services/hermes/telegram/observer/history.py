# ABOUTME: Импортирует доступную историю Telegram из нативных сессий Hermes в журнал наблюдения.
# ABOUTME: Не меняет исходные сессии и не выдаёт отсутствующие сведения за подтверждённые.
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(item.get("text", "") for item in content
                         if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str))
    return ""


def _time(value):
    try:
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _references(text, result_root, aliases):
    if not result_root or aliases is None:
        return []
    pattern = re.escape(result_root.rstrip("/")) + r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([^<>\n]+)"
    refs = []
    for match in re.finditer(pattern, text):
        path = match.group(0).rstrip(")")
        row = aliases.execute("SELECT ref FROM aliases WHERE path=? AND artifact=?", (path, match.group(1))).fetchone()
        if row:
            try:
                ref = json.loads(row[0])
                if ref.get("artifactId") == match.group(1) and ref not in refs:
                    refs.append(ref)
            except (ValueError, TypeError, AttributeError):
                pass
    return refs


def _input_references(aliases, chat_id, thread_id, message_id):
    if aliases is None or not message_id:
        return []
    refs = []
    rows = aliases.execute("""SELECT ref FROM items WHERE artifact IS NOT NULL AND ref IS NOT NULL
        AND json_extract(source, '$.platform')='telegram' AND json_extract(source, '$.chat')=?
        AND json_extract(source, '$.thread') IN (?, ?) AND json_extract(source, '$.messageId')=?
        ORDER BY position""", (chat_id, thread_id, '1' if thread_id == '' else thread_id, message_id))
    for row in rows:
        try:
            ref = json.loads(row[0])
            if isinstance(ref, dict) and ref.get('artifactId') and ref not in refs:
                refs.append(ref)
        except (ValueError, TypeError):
            pass
    return refs


def import_history(source, journal, allows, result_root="", aliases=None):
    """Прочитать допустимые Telegram-сессии, включая сжатые продолжения, без изменения источника."""
    sessions, session_offset = [], 0
    while True:
        # Сначала страница исходных сессий: проекция на compression tip может уменьшить
        # страницу и ошибочно остановить чтение до следующих страниц.
        page = source.list_sessions_rich(source="telegram", limit=100, offset=session_offset, include_archived=True,
            include_hidden=True, include_children=True, project_compression_tips=False)
        sessions.extend(page)
        if len(page) < 100:
            break
        session_offset += len(page)
    pending, seen = [], set()
    for session in sessions:
        if not allows(session):
            continue
        session_id = str(session.get("id") or "")
        chat_id = str(session.get("chat_id") or "")
        thread_id = str(session.get("thread_id") or "")
        if thread_id == "1":
            thread_id = ""
        if not session_id or not chat_id:
            continue
        offset = 0
        while True:
            page = source.get_messages(session_id, include_compacted=True, include_ancestors=True, limit=100, offset=offset)
            for message in page:
                role, mid = message.get("role"), message.get("id")
                if role not in {"user", "assistant"} or not mid or mid in seen or message.get("_compressed_summary") or message.get("tool_calls"):
                    continue
                text = _text(message.get("content"))
                platform_id = str(message.get("platform_message_id") or "")
                identity = f"telegram:{chat_id}:{platform_id}" if role == "user" and platform_id.isdecimal() else f"history:{mid}"
                refs = _references(text, result_root, aliases)
                if role == "user":
                    refs.extend(ref for ref in _input_references(aliases, chat_id, thread_id, platform_id) if ref not in refs)
                content = message.get("content")
                had_media = isinstance(content, list) and any(isinstance(item, dict) and item.get("type") in {"image_url", "file", "file_url", "audio"} for item in content)
                if not text and not refs and not had_media:
                    continue
                seen.add(mid)
                value = {"identity": identity, "chat_id": chat_id, "thread_id": thread_id,
                         "chat_type": str(session.get("chat_type") or ""), "chat_name": str(session.get("display_name") or ""),
                         "author_id": "brai" if role == "assistant" else "", "author_name": "Brai" if role == "assistant" else "",
                         "direction": "out" if role == "assistant" else "in", "telegram_id": platform_id or None,
                         "session_id": session_id, "text": text, "occurred_at": _time(message.get("timestamp")),
                         "edited_at": None, "delivery": "unknown" if role == "assistant" else "received",
                         "attachment_state": "ready" if refs else "unavailable" if had_media else "none", "attachments": refs, "group_id": ""}
                pending.append(value)
            if len(page) < 100:
                break
            offset += len(page)
    # AIDEV-NOTE: Исторический импорт не перезаписывает уже полученное живое событие.
    for value in sorted(pending, key=lambda item: (item["occurred_at"] or "", item["identity"])):
        journal.record(value, only_if_new=True)
    return {"sessions": len(sessions), "messages": len(pending)}


def main():
    """Использовать закреплённый read-only SessionDB и операторские параметры текущего профиля."""
    from hermes_state import SessionDB
    from journal import TelegramJournal
    owner = os.environ.get("BRAI_TELEGRAM_OWNER_ID", "")
    group = os.environ.get("BRAI_TELEGRAM_CHAT_ID", "") or owner
    users = {owner, *filter(None, os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(","))}
    directory = os.environ.get("BRAI_TELEGRAM_STATE_DIR", "")
    if not re.fullmatch(r"[1-9][0-9]*", owner) or not Path(directory).is_absolute():
        raise RuntimeError("OBSERVER_CONFIGURATION_INVALID")
    def allows(session):
        chat, user, kind = str(session.get("chat_id") or ""), str(session.get("user_id") or ""), session.get("chat_type")
        return user in users and ((kind in {"private", "dm"} and chat == user) or
                                  (group.startswith("-") and chat == group and kind in {"group", "supergroup", "forum"}))
    aliases = None
    alias_path = Path(directory).parent / "brai-files/files.sqlite"
    if alias_path.is_file():
        aliases = sqlite3.connect(f"file:{alias_path}?mode=ro", uri=True)
    source = SessionDB(read_only=True)
    try:
        result = import_history(source, TelegramJournal(directory), allows, os.environ.get("BRAI_TELEGRAM_RESULT_ROOT", ""), aliases)
        print(json.dumps(result))
    finally:
        source.close()
        if aliases:
            aliases.close()


if __name__ == "__main__":
    main()
