"""Durable retry queue only; memory is stored by MemOS, never in a second database."""

import fcntl
import json
import logging
import os
import threading
import time
from pathlib import Path

from agent.memory_provider import spawn_context_thread
from utils import atomic_json_write

logger = logging.getLogger(__name__)


class Outbox:
    def __init__(self, home, client):
        self.root = Path(home) / "memos-rest"
        self.pending = self.root / "pending"
        self.receipts = self.root / "receipts"
        for path in (self.root, self.pending, self.receipts):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.chmod(0o700)
        self.client = client
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.worker = None

    def start(self):
        self.worker = spawn_context_thread(self._run, name="memos-rest-writer")
        self.worker.start()

    def submit(self, event_id, job):
        # Exclusive creation prevents one session overwriting another's delivery state.
        path = self.pending / (event_id + ".json")
        lock_path = self.root / "submit.lock"
        with lock_path.open("a", encoding="utf-8") as lock:
            os.chmod(lock_path, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            self._guard(job)
            if hasattr(self.client, 'register_job'):
                self.client.register_job(job)
            from .admin import json_file
            from .client import MemOSError
            for existing in (self.receipts / path.name, path):
                if existing.exists():
                    if job.get('request_hash') and json_file(existing).get('request_hash') != job['request_hash']:
                        raise MemOSError('Memory operation ID conflicts with its original payload')
                    return event_id
            if not (self.receipts / path.name).exists() and not path.exists():
                atomic_json_write(path, {**job, "event_id": event_id, "created_at": time.time(),
                                        "attempts": 0, "next_attempt": 0}, mode=0o600, fsync_dir=True)
        self.wake.set()
        return event_id

    def _guard(self, job):
        from .admin import json_file
        from .client import MemOSError
        config = json_file(self.root.parent / 'memos-rest.json')
        if not config.get('enabled', True) or config.get('frozen') or config.get('suspended'):
            raise MemOSError('Memory writes suspended/frozen')
        if config.get('routing_enabled') and (job.get('epoch') != config.get('memory_epoch')
                or job.get('generation') != config.get('generation', 1)):
            raise MemOSError('Legacy/stale job is fenced')

    def process_once(self):
        lock_path = self.root / "delivery.lock"
        with lock_path.open("a", encoding="utf-8") as lock:
            os.chmod(lock_path, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            def order(path):
                try:
                    return json.loads(path.read_text(encoding="utf-8")).get("created_at", 0)
                except (OSError, ValueError):
                    return 0  # Surface a damaged queue file before making later writes.
            paths = sorted(self.pending.glob("*.json"), key=order)
            for path in paths:
                if self.stop.is_set():
                    break
                job = None
                try:
                    if (self.receipts / path.name).exists():
                        path.unlink(missing_ok=True)
                        continue
                    job = json.loads(path.read_text(encoding="utf-8"))
                    if job.get("next_attempt", 0) > time.time():
                        break  # Keep mirror replacement/removal and turns in FIFO order.
                    self._guard(job)
                    def checkpoint(value):
                        atomic_json_write(path, value, mode=0o600, fsync_dir=True)
                    ids = self.client.execute(job, checkpoint)
                    atomic_json_write(self.receipts / path.name, {
                        "event_id": job["event_id"], "memory_ids": ids, "verified_at": time.time(),
                        "request_hash": job.get('request_hash'), "operation": job.get('operation'),
                        "logical_id": job.get('logical_id') or job.get('replacement_id'),
                        "epoch": job.get('epoch'), "fact_count": len(job.get('facts', [])),
                    }, mode=0o600, fsync_dir=True)
                    path.unlink(missing_ok=True)
                    directory = os.open(self.pending, os.O_DIRECTORY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                except Exception as exc:
                    # Neither response bodies nor dialogue text may enter operational logs.
                    error = str(exc) if type(exc).__name__ == "MemOSError" else type(exc).__name__
                    logger.warning("MemOS delivery deferred: %s", error)
                    if job is not None:
                        job["attempts"] = job.get("attempts", 0) + 1
                        job["next_attempt"] = time.time() + min(60, 2 ** min(job["attempts"], 6))
                        job["last_error"] = error
                        atomic_json_write(path, job, mode=0o600, fsync_dir=True)
                    break

    def _run(self):
        while not self.stop.is_set():
            try:
                self.process_once()
            except OSError as exc:
                logger.warning("MemOS delivery queue unavailable: %s", type(exc).__name__)
            self.wake.wait(1)
            self.wake.clear()

    def status(self):
        pending = list(self.pending.glob("*.json"))
        result = {"pending": len(pending), "verified_events": len(list(self.receipts.glob("*.json")))}
        errors = []
        for path in pending:
            try:
                error = json.loads(path.read_text(encoding="utf-8")).get("last_error")
                if error:
                    errors.append(error)
            except (OSError, ValueError):
                errors.append("Unreadable pending event")
        result["last_error"] = errors[-1] if errors else None
        return result

    def flush(self, timeout, event_id=None):
        deadline = time.monotonic() + timeout
        self.wake.set()
        while time.monotonic() < deadline:
            if event_id:
                if (self.receipts / (event_id + ".json")).exists():
                    return True
            elif not any(self.pending.glob("*.json")):
                return True
            time.sleep(0.05)
        return False

    def receipt(self, event_id):
        try:
            return json.loads((self.receipts / (event_id + ".json")).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def shutdown(self):
        if not self.flush(3):
            logger.warning("MemOS has pending deliveries; the durable queue will resume at next initialization")
        self.stop.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=2)
