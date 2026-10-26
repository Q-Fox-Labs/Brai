# ABOUTME: Управляет пользовательскими файлами Hermes через Artifacts независимо от канала.
# ABOUTME: Локально хранит только временные байты и служебные receipts наборов и доставки.
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import threading
import uuid


class FileError(Exception):
    """Безопасный код ошибки файловой операции без содержимого и адресов."""


def canonical(value):
    """Сериализовать identity одинаково после перезапуска."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def key(value):
    """Получить ограниченный непрозрачный ключ операции."""
    return sha256(canonical(value).encode()).hexdigest()


def artifact_id(value):
    """Принимать только UUID, независимо от регистра входа."""
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise FileError("INVALID_ARTIFACT_ID") from None


class FileStore:
    """Общая файловая граница одного owner; backend выполняет только files.* RPC."""

    def __init__(self, root, cache, owner, backend, read_roots=(), service_roots=()):
        """Подготовить service metadata и временную рабочую область, не сканируя профиль."""
        self.root, self.cache, self.owner = Path(root), Path(cache), owner
        self.backend = backend
        self._locks = threading.local()
        if not owner or not self.root.is_absolute() or not self.cache.is_absolute():
            raise FileError("FILES_CONFIG_INVALID")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.resolve() != self.root or self.cache.resolve() != self.cache:
            raise FileError("UNSAFE_FILES_ROOT")
        self.work = self.root / "work"
        self.work.mkdir(mode=0o700, exist_ok=True)
        self.read_roots = tuple(Path(p).resolve() for p in (*read_roots, self.work, self.cache))
        self.service_roots = tuple(Path(p).resolve() for p in service_roots)
        self.temporary_roots = (self.work, self.cache)
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (owner TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS items (
                  identity TEXT PRIMARY KEY, group_key TEXT NOT NULL, source TEXT NOT NULL,
                  position INTEGER NOT NULL, caption TEXT NOT NULL, path TEXT NOT NULL,
                  artifact TEXT, ref TEXT);
                CREATE TABLE IF NOT EXISTS groups (identity TEXT PRIMARY KEY, admitted TEXT);
                CREATE TABLE IF NOT EXISTS deliveries (identity TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL, receipts TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS leases (operation TEXT NOT NULL, artifact TEXT NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL, PRIMARY KEY(operation, artifact));
                CREATE TABLE IF NOT EXISTS aliases (path TEXT PRIMARY KEY, artifact TEXT NOT NULL, ref TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS publications (identity TEXT PRIMARY KEY, path TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS routes (group_key TEXT PRIMARY KEY, route TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tasks (identity TEXT PRIMARY KEY, operation TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs (identity TEXT PRIMARY KEY, operation TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS cleanup_scopes (operation TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(operation,scope));
            """)
            owners = [row[0] for row in db.execute("SELECT owner FROM settings")]
            if owners and owners != [owner]:
                raise FileError("OWNER_MISMATCH")
            db.execute("INSERT OR IGNORE INTO settings VALUES (?)", (owner,))

    @contextmanager
    def db(self):
        """Открыть отдельную SQLite connection: потоки и процессы не делят transaction."""
        db = sqlite3.connect(self.root / "files.sqlite", timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def lock(self, identity, blocking=True):
        """Сериализовать один receipt между gateway, CLI и фоновыми процессами."""
        identity = key(identity)
        held = getattr(self._locks, 'held', {})
        if identity in held and not blocking:
            raise FileError("OPERATION_IN_PROGRESS")
        if identity in held:
            yield
            return
        path = self.root / ("lock-" + identity)
        with path.open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                raise FileError("OPERATION_IN_PROGRESS") from None
            self._locks.held = {**held, identity: True}
            try:
                yield
            finally:
                self._locks.held = held
                fcntl.flock(handle, fcntl.LOCK_UN)

    def call(self, method, args):
        """Не повторять RPC при ошибке или неизвестном исходе."""
        try:
            return self.backend.call(method, args, timeout=1800 if method in {"files.fetch", "files.publish"} else 30)
        except Exception:
            raise FileError("ARTIFACTS_UNAVAILABLE") from None

    def checked(self, result):
        """Проверить точный publisher cache path, размер и SHA-256 обычного файла."""
        try:
            aid = artifact_id(result["artifactId"])
            name = result["filename"]
            path = Path(result["localPath"])
            if (not name or Path(name).name != name or path != self.cache / aid / name
                    or path.resolve() != path or not stat.S_ISREG(path.lstat().st_mode)
                    or type(result["sizeBytes"]) is not int or not 0 <= result["sizeBytes"] <= 2**31):
                raise FileError("INVALID_FILE_RESULT")
            digest, size = sha256(), 0
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
                    size += len(chunk)
                    if size > 2**31:
                        raise FileError("FILE_TOO_LARGE")
            if size != result["sizeBytes"] or digest.hexdigest() != result["sha256"]:
                raise FileError("HASH_MISMATCH")
            if not isinstance(result["mimeType"], str) or not result["mimeType"] or result["artifactId"] != aid:
                raise FileError("INVALID_FILE_RESULT")
            return {field: result[field] for field in ("artifactId", "filename", "mimeType", "sizeBytes", "sha256")}
        except (KeyError, TypeError, OSError):
            raise FileError("INVALID_FILE_RESULT") from None

    def fetch(self, aid):
        """Каждый доступ подтверждает ready/owner у publisher; локальный кэш не authority."""
        aid = artifact_id(aid)
        result = self.call("files.fetch", {"artifactId": aid})
        if result.get("artifactId") != aid:
            raise FileError("INVALID_FILE_RESULT")
        ref = self.checked(result)
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", (result["localPath"], ref["artifactId"], canonical(ref)))
        return result

    def publish(self, path, identity):
        """Опубликовать конкретный файл, а не содержимое каталога; receipt переживает restart."""
        path = Path(path)
        resolved = path.resolve(strict=True)
        if not any(resolved.is_relative_to(root) for root in self.read_roots):
            raise FileError("READ_ROOT_DENIED")
        publication = key([self.owner, identity])
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO publications VALUES (?,?,0)", (publication, str(path)))
        result = self.call("files.publish", {"path": str(path), "requestId": "hermes-file:" + publication})
        ref = self.checked(result)
        with self.db() as db:
            db.execute("UPDATE publications SET confirmed=1 WHERE identity=?", (publication,))
            db.execute("INSERT INTO aliases VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET artifact=excluded.artifact,ref=excluded.ref",
                       (str(path), ref["artifactId"], canonical(ref)))
            db.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", (result["localPath"], ref["artifactId"], canonical(ref)))
        return result

    def ingest(self, source, item_id, path, position=0, caption="", group_id=None):
        """Сохранить элемент по исходной identity до сборки альбома; порядок не входит в ключ файла."""
        required = {"platform", "account", "chat", "thread", "sender"}
        if (set(source) != required or any(not isinstance(v, str) for v in source.values())
                or not source["platform"] or not source["account"] or not isinstance(item_id, str) or not item_id
                or type(position) is not int or position < 0 or not isinstance(caption, str)):
            raise FileError("INVALID_SOURCE")
        identity = key([self.owner, source, item_id])
        group = key([self.owner, source, group_id if group_id is not None else item_id])
        with self.lock(identity):
            with self.db() as db:
                row = db.execute("SELECT * FROM items WHERE identity=?", (identity,)).fetchone()
                if row and (row["group_key"] != group or row["caption"] != caption):
                    raise FileError("SOURCE_CONFLICT")
                db.execute("INSERT OR IGNORE INTO groups(identity) VALUES (?)", (group,))
                db.execute("INSERT OR IGNORE INTO items VALUES (?,?,?,?,?,?,NULL,NULL)",
                           (identity, group, canonical({**source, "itemId": item_id, "sourceGroupId": group_id}), position, caption, str(path)))
            result = self.fetch(row["artifact"]) if row and row["artifact"] else self.publish(path, ["input", identity])
            ref = self.checked(result)
            with self.db() as db:
                db.execute("UPDATE items SET artifact=?,ref=? WHERE identity=?", (ref["artifactId"], canonical(ref), identity))
            return {"groupId": group, "itemId": identity, "file": ref, "localPath": result["localPath"]}

    def admit(self, group):
        """Вернуть только новую готовую версию набора; прежнюю работу не запускать снова."""
        with self.lock(group):
            with self.db() as db:
                rows = db.execute("SELECT * FROM items WHERE group_key=? ORDER BY position, identity", (group,)).fetchall()
                if not rows or any(not row["artifact"] for row in rows):
                    raise FileError("INCOMPLETE_FILE_SET")
                state = db.execute("SELECT admitted FROM groups WHERE identity=?", (group,)).fetchone()
                version = key([row["identity"] for row in rows])
                previous = json.loads(state[0]) if state[0] else []
                current = [row["identity"] for row in rows]
                added = [row for row in rows if row["identity"] not in previous]
                if not added:
                    return {"groupId": group, "version": version, "duplicate": True, "items": []}
                for row in rows:
                    self.fetch(row["artifact"])
                db.execute("UPDATE groups SET admitted=? WHERE identity=?", (canonical(current), group))
            return {"groupId": group, "version": version, "duplicate": False, "supplement": bool(previous),
                    "items": [{"file": json.loads(row["ref"]), "caption": row["caption"], "source": json.loads(row["source"])} for row in added]}

    def resolve(self, path, identity):
        """Восстановить старую ссылку или сохранить явно выбранный результат обработки."""
        path = str(Path(path).absolute())
        with self.db() as db:
            row = db.execute("SELECT artifact FROM aliases WHERE path=?", (path,)).fetchone()
        if row:
            # Рабочая копия могла измениться: прежний ID допустим только для тех же байтов.
            result = self.fetch(row[0])
            if not Path(path).exists() or Path(path) == Path(result["localPath"]):
                return result
            digest = sha256()
            with open(path, "rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
            if digest.hexdigest() == result["sha256"]:
                return result
        candidate = Path(path)
        if candidate.parent.parent == self.cache:
            return self.fetch(artifact_id(candidate.parent.name))
        return self.publish(path, [identity, "revision", digest.hexdigest()] if row else identity)

    def workspace(self, operation):
        """Создать временный cwd; операция не получает постоянного каталога пользовательских файлов."""
        path = self.work / key([self.owner, operation])
        path.mkdir(mode=0o700, exist_ok=True)
        if path.resolve() != path:
            raise FileError("UNSAFE_WORKSPACE")
        return path

    @contextmanager
    def materialize(self, refs, operation):
        """Закрепить весь набор до первого send и освободить leases только после доставки."""
        aids = [artifact_id(ref["artifactId"]) for ref in refs]
        token = key([self.owner, operation, str(uuid.uuid4())])
        files = []
        with self.lock("cache"):
            with self.db() as db:
                for aid in set(aids):
                    db.execute("INSERT OR IGNORE INTO leases VALUES (?,?,?,?)", (token, aid, os.getpid(), process_start(os.getpid())))
            try:
                files = [self.fetch(aid) for aid in aids]
                for ref, file in zip(refs, files):
                    if any(ref.get(field) is not None and ref[field] != file[field]
                           for field in ("artifactId", "filename", "sizeBytes", "sha256", "mimeType")):
                        raise FileError("FILE_REFERENCE_MISMATCH")
            except Exception:
                with self.db() as db:
                    db.execute("DELETE FROM leases WHERE operation=?", (token,))
                raise
        try:
            yield files
        finally:
            with self.lock("cache"):
                with self.db() as db:
                    db.execute("DELETE FROM leases WHERE operation=?", (token,))

    def cleanup(self, operation, cache=True):
        """Удалить только свою завершённую рабочую область и незакреплённые подтверждённые кэши."""
        with self.lock("cache"):
            with self.db() as db:
                if db.execute("SELECT 1 FROM deliveries WHERE identity=? AND state='unknown'", (operation if isinstance(operation, str) else key(operation),)).fetchone():
                    return
                pending = {row[0] for row in db.execute("SELECT path FROM items WHERE artifact IS NULL UNION SELECT path FROM publications WHERE confirmed=0")}
                for row in db.execute("SELECT DISTINCT operation, pid, started FROM leases").fetchall():
                    if process_start(row["pid"]) != row["started"]:
                        db.execute("DELETE FROM leases WHERE operation=?", (row["operation"],))
                leased = {row[0] for row in db.execute("SELECT artifact FROM leases")}
                cached = list(db.execute("SELECT artifact FROM aliases UNION SELECT artifact FROM items WHERE artifact IS NOT NULL"))
            work = self.work / key([self.owner, operation])
            if workspace_in_use(work):
                return
            if not any(Path(path).is_relative_to(work) for path in pending):
                shutil.rmtree(work, ignore_errors=False) if work.exists() else None
            with self.db() as db:
                originals = [row[0] for row in db.execute("SELECT path FROM items WHERE artifact IS NOT NULL UNION SELECT path FROM publications WHERE confirmed=1")]
            # AIDEV-NOTE: allowedReadRoots не даёт права удаления. Только специально
            # объявленные временные каталоги; старые пользовательские пути миграции сохраняются.
            for original in originals:
                path = Path(original)
                if (original not in pending and path.is_absolute() and path.exists() and not path.is_symlink()
                        and path.is_file() and not path.is_relative_to(self.cache)
                        and any(path.resolve().is_relative_to(root) for root in self.temporary_roots)
                        and not any(path.resolve().is_relative_to(root) for root in self.service_roots)):
                    path.unlink()
            if not cache:
                return
            for row in cached:
                aid = artifact_id(row[0])
                directory = self.cache / aid
                if aid not in leased and directory.is_dir() and directory.resolve() == directory:
                    for path in directory.iterdir():
                        if path.is_file() and not path.is_symlink() and str(path) not in pending:
                            path.unlink()
                    if not any(directory.iterdir()):
                        directory.rmdir()


    def resume_publications(self):
        """Восстановить неизвестные публикации только с прежним ключом и сохранёнными байтами."""
        with self.db() as db:
            pending = db.execute("SELECT identity,path FROM publications WHERE confirmed=0").fetchall()
        for row in pending:
            result = self.call("files.publish", {"path": row["path"], "requestId": "hermes-file:" + row["identity"]})
            ref = self.checked(result)
            with self.db() as db:
                db.execute("UPDATE publications SET confirmed=1 WHERE identity=?", (row["identity"],))
                db.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", (row["path"], ref["artifactId"], canonical(ref)))
                db.execute("INSERT OR REPLACE INTO aliases VALUES (?,?,?)", (result["localPath"], ref["artifactId"], canonical(ref)))
                db.execute("UPDATE items SET artifact=?,ref=? WHERE path=? AND artifact IS NULL",
                           (ref["artifactId"], canonical(ref), row["path"]))

    def pin_operation(self, ref, operation):
        """Удержать файл операции также в worker, где нет ContextVar родителя."""
        token = "task:" + key([self.owner, operation])
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO leases VALUES (?,?,?,?)",
                       (token, artifact_id(ref["artifactId"]), os.getpid(), process_start(os.getpid())))

    def release_operation(self, operation):
        """Освободить leases завершившегося агента, сохранив дочерние операции."""
        with self.lock("cache"), self.db() as db:
            db.execute("DELETE FROM leases WHERE operation=?", ("task:" + key([self.owner, operation]),))


def delivery_plan(items, mode="files"):
    """Детерминированно разбить набор без перестановки и без молчаливой потери подписей."""
    if mode not in {"files", "album"} or not items:
        raise FileError("INVALID_FILE_SET")
    kinds = [item.get("presentation", "photo" if item["file"]["mimeType"] in {"image/jpeg", "image/png", "image/webp"} else
                       "video" if item["file"]["mimeType"].startswith("video/") else "document") for item in items]
    compatible = (set(kinds) <= {"photo", "video"} or len(set(kinds)) == 1 and kinds[0] in {"document", "audio"})
    album = mode == "album" and compatible
    chunks = [items[i:i+10] for i in range(0, len(items), 10)] if album else [[item] for item in items]
    return {"fallback": mode == "album" and not compatible,
            "batches": [{"kind": "album" if album and len(chunk) > 1 else "single", "items": chunk} for chunk in chunks]}


async def deliver(store, delivery_id, items, sender, mode="files"):
    """Отправить подготовленный набор; неизвестный исход никогда автоматически не повторяется."""
    payload = canonical({"items": items, "mode": mode})
    plan = delivery_plan(items, mode)
    # Nonblocking lock не останавливает event loop второго отправителя.
    with store.lock(["delivery", delivery_id], blocking=False):
        with store.db() as db:
            old = db.execute("SELECT * FROM deliveries WHERE identity=?", (delivery_id,)).fetchone()
            if old:
                if old["payload"] != payload:
                    raise FileError("DELIVERY_CONFLICT")
                return {"state": old["state"], "receipts": json.loads(old["receipts"]), "repeated": True}
        lease = store.materialize([item["file"] for item in items], delivery_id)
        files = await asyncio.to_thread(lease.__enter__)
        try:
            with store.db() as db:
                db.execute("INSERT INTO deliveries VALUES (?,?,?,?)", (delivery_id, payload, "prepared", "[]"))
            receipts, offset = [], 0
            for batch in plan["batches"]:
                prepared = []
                for item, file in zip(batch["items"], files[offset:]):
                    prepared.append({**item, "localPath": file["localPath"]})
                offset += len(prepared)
                # Записать unknown ДО вызова канала: crash после отправки не разрешает повтор.
                with store.db() as db:
                    db.execute("UPDATE deliveries SET state='unknown' WHERE identity=?", (delivery_id,))
                try:
                    result = await sender(batch["kind"], prepared, plan["fallback"])
                    if not isinstance(result, list) or len(result) != len(prepared) or any(mid is None or not str(mid) for mid in result):
                        raise FileError("DELIVERY_UNKNOWN")
                except Exception:
                    return {"state": "unknown", "receipts": receipts}
                receipts.extend({"artifactId": item["file"]["artifactId"], "messageId": str(mid)} for item, mid in zip(prepared, result))
                with store.db() as db:
                    db.execute("UPDATE deliveries SET receipts=? WHERE identity=?", (canonical(receipts), delivery_id))
            with store.db() as db:
                db.execute("UPDATE deliveries SET state='sent' WHERE identity=?", (delivery_id,))
        finally:
            await asyncio.to_thread(lease.__exit__, None, None, None)
        return {"state": "sent", "receipts": receipts, "fallback": plan["fallback"]}


def process_start(pid):
    """Отличать живые процессы и переиспользованный PID при очистке lease после crash."""
    try:
        return Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def workspace_in_use(workspace):
    """Не удалить cwd ещё работающего terminal/background процесса данного Unix owner."""
    if not workspace.exists():
        return False
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid == os.getuid() and (entry / 'cwd').resolve(strict=True).is_relative_to(workspace):
                return True
        except (OSError, RuntimeError):
            continue
    return False
