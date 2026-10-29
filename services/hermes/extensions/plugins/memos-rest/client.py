# ABOUTME: Доставляет и проверяет записи памяти через ограниченный API MemOS.
# ABOUTME: Длинные сообщения сохраняются частями без потери исходного диалога.
"""MemOS product API; all reads and writes explicitly select one configured cube."""

import hashlib
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request


MAX_MEMORY_PART_BYTES = 768


class MemOSError(RuntimeError):
    pass


def memory_rows(response):
    data = response.get("data", {})
    if not isinstance(data, dict):
        raise MemOSError("MemOS returned an invalid memory result")
    rows = []
    for category in ("text_mem", "pref_mem", "tool_mem", "skill_mem"):
        for group in data.get(category, []) or []:
            rows.extend({**row, "_cube_id": group.get("cube_id")} for row in group.get("memories", []) or [])
    return rows


def business_private(row):
    info = (row.get('metadata') or {}).get('info') or {}
    return info.get('hermes_visibility') == 'business_private' or info.get('hermes_business_scope') is not None


def stored_text(value):
    """Снять только служебный префикс SimpleStruct, сохранив само содержимое."""
    return re.sub(r'^(?:user|assistant): \[[^\]\n]+\]:[ \t]*', '', str(value)).rstrip('\n')


def fact_fields(content):
    """Закрепить отдельный текст факта и его SHA-256; цитата хранится независимо."""
    return {'hermes_fact_text': content,
            'hermes_fact_sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()}


def document_references(text):
    """Найти реальные файловые ссылки без угадывания темы документа."""
    paths = re.findall(
        r'''(?<![^\s<>"'`])[^\s<>"'`]+\.(?:pdf|docx?|odt|md|txt|html|xlsx?|csv)(?:\?[^\s<>"'`]*)?''',
        text, re.IGNORECASE)
    identifiers = re.findall(r'''(?:artifact:/{0,2}|\[artifactId=|"artifactId"\s*:\s*")([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})''', text)
    return list(dict.fromkeys([*paths, *('artifact:' + value.lower() for value in identifiers)]))


def internal_dialogue(messages):
    """Распознать протокол фонового результата Hermes, а не слова о делегировании."""
    users = [m.get('content', '') for m in messages or [] if m.get('role') == 'user']
    return bool(users) and all(isinstance(text, str) and re.match(
        r'^(?:\[[^\]\n]+\]\s*)?\[ASYNC DELEGATION BATCH COMPLETE[^\n]*\]\s*'
        r'A background fan-out unit you dispatched earlier', text) for text in users)


def memory_text(row):
    """Прочитать факт без подмены источником и проверить новое каноническое поле."""
    info = (row.get('metadata') or {}).get('info') or {}
    if info.get('hermes_kind') != 'fact':
        return row.get('memory', '')
    text = info.get('hermes_fact_text')
    if text is None:
        return stored_text(row.get('memory', ''))
    if not isinstance(text, str) or fact_fields(text)['hermes_fact_sha256'] != info.get('hermes_fact_sha256'):
        raise MemOSError('Fact text checksum mismatch')
    expected = text
    if 'hermes_chunk_index' in info:
        parts = dialogue_parts([{'role': 'user', 'content': text}])
        index = info['hermes_chunk_index']
        if type(index) is not int or not 0 <= index < len(parts) or len(parts) != info.get('hermes_chunk_count'):
            raise MemOSError('Fact text part identity mismatch')
        expected = parts[index]['content']
    if stored_text(row.get('memory', '')) != expected.rstrip('\n'):
        raise MemOSError('Stored fact content differs from canonical text')
    return text


def public_memory(row):
    meta = row.get("metadata") or {}
    info = meta.get("info") or {}
    return {
        "id": row.get("id"), "content": memory_text(row),
        "document_refs": document_references(memory_text(row)),
        "document_metadata": row.get('_document_metadata', []),
        "session_id": meta.get("session_id"), "created_at": meta.get("created_at"),
        "source_date": row.get('_source_date'),
        "relevance": (1.0 if row.get('_relevance') == 'direct' else .5
                      if row.get('_relevance') == 'supporting' else meta.get("relativity")),
        "relevance_kind": row.get('_relevance'), "relevance_reason": row.get('_relevance_reason'),
        "author_id": info.get("hermes_author_id"),
        "author_name": info.get("hermes_author_name"),
        "kind": info.get("hermes_kind"),
        "logical_id": info.get("hermes_logical_id"),
        "cube_id": row.get("_cube_id"), "memberships": info.get("hermes_memberships", []),
        "subject_id": info.get("hermes_subject_id"), "projects": info.get("hermes_projects", []),
        "status": info.get("hermes_status"), "source_event": info.get("hermes_source_event"),
        "source_ids": info.get("hermes_source_ids", []), "source": info.get("hermes_source"),
        "deployment_phase": info.get("hermes_deployment_phase"), "memory_epoch": info.get("hermes_memory_epoch"),
        "classification": row.get("_classification", info.get("hermes_classification")),
    }


def dialogue_parts(messages, limit=MAX_MEMORY_PART_BYTES):
    """Разделить текст на части по UTF-8 без потери символов и порядка ролей."""
    parts = []
    for message in messages:
        text = message['content']
        start = 0
        size = 0
        for index, char in enumerate(text):
            width = len(char.encode('utf-8'))
            if size + width > limit:
                parts.append({**message, 'content': text[start:index]})
                start, size = index, 0
            size += width
        if start < len(text):
            parts.append({**message, 'content': text[start:]})
    return parts


class Client:
    def __init__(self, config):
        self.base_url = str(config["base_url"]).rstrip("/")
        parsed = urllib.parse.urlsplit(self.base_url)
        if (parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("MemOS REST URL must be HTTP on loopback (this service has no authentication)")
        self.user_id = str(config["user_id"])
        self.cube_id = str(config["cube_id"])
        self.timeout = float(config.get("request_timeout", 30))
        # A proxy configured for other providers must never see local memory traffic.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path, body=None, *, timeout=None):
        request = urllib.request.Request(
            self.base_url + path,
            data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=timeout or self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise MemOSError(f"MemOS {path}: HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            raise MemOSError(f"MemOS {path}: connection failed ({type(exc).__name__})") from None
        except (ValueError, UnicodeError):
            raise MemOSError(f"MemOS {path}: invalid JSON response") from None
        if not isinstance(result, dict) or result.get("code", 200) != 200:
            code = result.get("code", "unknown") if isinstance(result, dict) else "invalid"
            raise MemOSError(f"MemOS {path}: API error {code}")
        return result

    def health(self):
        return self.request("/health", timeout=3)

    def get(self, filter_):
        server_filter = {("info." + key if key.startswith("hermes_") else key): value
                         for key, value in filter_.items()}
        rows = memory_rows(self.request("/product/get_memory", {
            "mem_cube_id": self.cube_id, "user_id": self.user_id, "filter": server_filter,
            "include_preference": False, "include_tool_memory": False, "include_skill_memory": False,
        }))
        # The installed PostgreSQL export_graph ignores REST filter/user_id kwargs.
        # Never trust those as a selection boundary, especially for recovery/deletion.
        def matches(row):
            meta = row.get("metadata") or {}
            info = meta.get("info") or {}
            if meta.get("user_id") != self.user_id:
                return False
            if row.get("_cube_id") not in (None, self.cube_id):
                return False
            for key, value in filter_.items():
                if key.startswith("hermes_"):
                    actual = info.get(key)
                elif key.startswith("info."):
                    actual = info.get(key[5:])
                elif key == "id":
                    actual = row.get("id")
                else:
                    actual = meta.get(key)
                if actual != value:
                    return False
            return True
        return [row for row in rows if matches(row)]

    def read(self, memory_id, *, include_private=False):
        rows = self.get({"id": str(memory_id)})
        return next((row for row in rows if row.get("id") == memory_id
                     and (include_private or not business_private(row))), None)

    def search(self, query, session_id, *, top_k=None, relativity=0.45):
        """Искать без скрытого лимита; None выбирает все хранимые кандидаты."""
        if top_k is None:
            top_k = len(self.get({}))
        if not top_k:
            return []
        result = self.request("/product/search", {
            "user_id": self.user_id, "readable_cube_ids": [self.cube_id],
            "session_id": session_id or None, "query": query, "top_k": top_k,
            # Routed recall deduplicates source/logical IDs after scope checks.
            # MMR over the complete archive is quadratic and removes independent
            # facts before that boundary; no semantic dedup is needed here.
            "mode": "fast", "relativity": relativity, "rerank": True, "dedup": "no",
            "include_preference": False, "search_tool_memory": False, "include_skill_memory": False,
            "internet_search": False, "chat_history": [],
        }, timeout=self.timeout)
        return [row for row in memory_rows(result)
                if (row.get("metadata") or {}).get("user_id") == self.user_id and not business_private(row)]

    def add(self, body):
        body = {**body, "user_id": self.user_id, "writable_cube_ids": [self.cube_id],
                "async_mode": "sync", "mode": "fast", "chat_history": []}
        result = self.request("/product/add", body)
        data = result.get("data")
        if not isinstance(data, list) or not data:
            raise MemOSError("MemOS acknowledged add without committed memory IDs")
        ids = [row.get("memory_id") for row in data if row.get("cube_id") == self.cube_id]
        if len(ids) != len(data) or not all(isinstance(id_, str) and id_ for id_ in ids):
            raise MemOSError("MemOS add returned invalid memory IDs or a different cube")
        return ids

    def verify(self, job, ids):
        info = job["body"]["info"]
        rows = self.get({"hermes_event_id": info["hermes_event_id"]})
        expected = set(ids)
        verified = set()
        mismatches = set()
        expected_text = '\n'.join(message['content'] for message in job['body']['messages'])
        def content_matches(row):
            if info.get('hermes_kind') == 'fact':
                expected_part = expected_text
                stored_info = (row.get('metadata') or {}).get('info') or {}
                if 'hermes_chunk_index' not in info and 'hermes_chunk_index' in stored_info:
                    parts = dialogue_parts(job['body']['messages'])
                    index = stored_info['hermes_chunk_index']
                    if (type(index) is not int or not 0 <= index < len(parts)
                            or len(parts) != stored_info.get('hermes_chunk_count')):
                        return False
                    expected_part = parts[index]['content']
                return stored_text(row.get('memory', '')) == expected_part.rstrip('\n')
            return ('hermes_chunk_index' not in info
                    or job['body']['messages'][0]['content'] in row.get('memory', ''))
        for row in rows:
            meta = row.get("metadata") or {}
            stored = meta.get("info") or {}
            if row.get("id") in expected:
                mismatches.update(key for key, value in info.items() if stored.get(key) != value)
                if meta.get("user_id") != self.user_id:
                    mismatches.add("user_id")
                if meta.get("session_id") != job["body"]["session_id"]:
                    mismatches.add("session_id")
                if not content_matches(row):
                    mismatches.add("chunk_content" if 'hermes_chunk_index' in info else "content")
            if (row.get("id") in expected and meta.get("user_id") == self.user_id
                    and meta.get("session_id") == job["body"]["session_id"]
                    and content_matches(row)
                    and all(stored.get(key) == value for key, value in info.items())):
                verified.add(row["id"])
        if info.get('hermes_kind') == 'fact' and 'hermes_chunk_index' not in info:
            committed = [row for row in rows if row.get('id') in verified]
            if any('hermes_chunk_index' in row['metadata']['info'] for row in committed):
                indices = [row['metadata']['info'].get('hermes_chunk_index') for row in committed]
                if sorted(indices, key=str) != sorted(range(len(dialogue_parts(job['body']['messages']))), key=str):
                    mismatches.add('incomplete_fact_parts')
                    verified.clear()
        if not expected or verified != expected:
            detail = ", ".join(sorted(mismatches)) if mismatches else "missing memory IDs"
            raise MemOSError("MemOS read-back did not verify the complete dialogue payload: " + detail)
        return sorted(verified)

    def delete(self, ids):
        if not ids:
            return
        self.request("/product/delete_memory", {"writable_cube_ids": [self.cube_id],
                                                "memory_ids": ids, "auto_cleanup_working": False})
        if any(self.read(id_, include_private=True) is not None for id_ in ids):
            raise MemOSError("MemOS did not verify deletion")

    def execute(self, job, checkpoint):
        """Доставить событие с восстановлением подтверждённых частей после сбоя."""
        if job.get("operation") == "delete":
            rows = self.get(job["filter"])
            ids = [row["id"] for row in rows if not job.get("exclude_private") or not business_private(row)]
            self.delete(ids)
            return ids
        ids = job.get("memory_ids", [])
        if ids:
            verified = self.verify(job, ids)
        else:
            body = job["body"]
            parts = dialogue_parts(body["messages"])
            split = len(parts) > 1 and sum(len(row["content"].encode("utf-8")) for row in body["messages"]) > MAX_MEMORY_PART_BYTES
            if split or "memory_parts" in job:
                # AIDEV-NOTE: Запись плана до первого add позволяет восстановить потерянный ответ
                # по event ID и номеру части, не создавая повторную копию.
                if "memory_parts" not in job:
                    existing = self.get({"hermes_event_id": body["info"]["hermes_event_id"]})
                    if existing:
                        ids = [row["id"] for row in existing]
                        verified = self.verify(job, ids)
                        job["memory_ids"] = ids
                        checkpoint(job)
                    else:
                        job["memory_parts"] = [{} for _ in parts]
                        checkpoint(job)
                if "memory_parts" in job:
                    if len(job["memory_parts"]) != len(parts):
                        raise MemOSError("Memory part plan does not match the dialogue")
                    ids = []
                    for index, part in enumerate(parts):
                        info = {**body["info"], "hermes_chunk_index": index, "hermes_chunk_count": len(parts)}
                        unit = job["memory_parts"][index]
                        unit["body"] = {**body, "messages": [part], "info": info}
                        ids.extend(self._execute_one(unit, lambda _: checkpoint(job)))
                    job["memory_ids"] = ids
                    checkpoint(job)
                    verified = self.verify(job, ids)
            else:
                verified = self._execute_one(job, checkpoint)
                ids = job["memory_ids"]
        if job.get("delete_filter"):
            self.delete([row["id"] for row in self.get(job["delete_filter"]) if row["id"] not in ids])
        return verified

    def _execute_one(self, job, checkpoint):
        ids = job.get("memory_ids", [])
        if not ids:
            info = job["body"]["info"]
            filter_ = {"hermes_event_id": info["hermes_event_id"]}
            if "hermes_chunk_index" in info:
                filter_["hermes_chunk_index"] = info["hermes_chunk_index"]
            rows = self.get(filter_)
            ids = [row["id"] for row in rows]
            if not ids:
                ids = self.add(job["body"])
            job["memory_ids"] = ids
            checkpoint(job)
        return self.verify(job, ids)
