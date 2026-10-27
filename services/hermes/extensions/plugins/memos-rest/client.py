"""MemOS product API; all reads and writes explicitly select one configured cube."""

import json
import socket
import urllib.error
import urllib.parse
import urllib.request


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


def public_memory(row):
    meta = row.get("metadata") or {}
    info = meta.get("info") or {}
    return {
        "id": row.get("id"), "content": row.get("memory", ""),
        "session_id": meta.get("session_id"), "created_at": meta.get("created_at"),
        "relevance": meta.get("relativity"),
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

    def search(self, query, session_id, *, top_k=6, relativity=0.45):
        result = self.request("/product/search", {
            "user_id": self.user_id, "readable_cube_ids": [self.cube_id],
            "session_id": session_id or None, "query": query, "top_k": top_k,
            "mode": "fast", "relativity": relativity, "rerank": True, "dedup": "mmr",
            "include_preference": False, "search_tool_memory": False, "include_skill_memory": False,
            "internet_search": False, "chat_history": [],
        }, timeout=min(self.timeout, 5))
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
        for row in rows:
            meta = row.get("metadata") or {}
            stored = meta.get("info") or {}
            if row.get("id") in expected:
                mismatches.update(key for key, value in info.items() if stored.get(key) != value)
                if meta.get("user_id") != self.user_id:
                    mismatches.add("user_id")
                if meta.get("session_id") != job["body"]["session_id"]:
                    mismatches.add("session_id")
            if (row.get("id") in expected and meta.get("user_id") == self.user_id
                    and meta.get("session_id") == job["body"]["session_id"]
                    and all(stored.get(key) == value for key, value in info.items())):
                verified.add(row["id"])
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
        if job.get("operation") == "delete":
            ids = [row["id"] for row in self.get(job["filter"])]
            self.delete(ids)
            return ids
        ids = job.get("memory_ids", [])
        if not ids:
            # Recover a successful commit whose response/acknowledgement was lost.
            rows = self.get({"hermes_event_id": job["body"]["info"]["hermes_event_id"]})
            ids = [row["id"] for row in rows]
            if not ids:
                ids = self.add(job["body"])
            job["memory_ids"] = ids
            checkpoint(job)
        verified = self.verify(job, ids)
        if job.get("delete_filter"):
            self.delete([row["id"] for row in self.get(job["delete_filter"]) if row["id"] not in ids])
        return verified
