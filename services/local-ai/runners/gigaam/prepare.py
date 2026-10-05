#!/usr/bin/env python3
# ABOUTME: Загружает и проверяет публичный неизменяемый snapshot GigaAM-v3 e2e CTC.
# ABOUTME: Использует только стандартную библиотеку и не читает учётные данные Hugging Face.

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


MANIFEST = Path(__file__).with_name("model_manifest.json")
MAX_REDIRECT_HOST_SUFFIXES = ("huggingface.co", "hf.co")


def _safe_host(url: str) -> bool:
    """Разрешить HTTPS с Hugging Face и его хостов перенаправления артефактов."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and any(
        host == suffix or host.endswith("." + suffix)
        for suffix in MAX_REDIRECT_HOST_SUFFIXES
    )


def _download_file(repo: str, revision: str, entry: dict[str, object], target: Path) -> None:
    """Загрузить публичный артефакт и проверить длину и SHA-256."""
    rel_path = str(entry["path"])
    if Path(rel_path).name != rel_path:
        raise ValueError("invalid manifest path")
    expected_bytes = int(entry["bytes"])
    expected_sha = str(entry["sha256"])
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{quote(rel_path)}"
    request = Request(url, headers={"User-Agent": "Brai-local-ai/1"})
    digest = hashlib.sha256()
    actual_bytes = 0
    with urlopen(request, timeout=60) as response, target.open("xb") as output:
        if not _safe_host(response.geturl()):
            raise ValueError("unexpected artifact host")
        while block := response.read(1024 * 1024):
            actual_bytes += len(block)
            if actual_bytes > expected_bytes:
                raise ValueError("artifact size mismatch")
            digest.update(block)
            output.write(block)
        output.flush()
        os.fsync(output.fileno())
    if actual_bytes != expected_bytes or digest.hexdigest() != expected_sha:
        raise ValueError("artifact checksum mismatch")
    target.chmod(0o444)


def verify_snapshot(destination: Path, manifest: dict[str, object]) -> None:
    """Проверить все обязательные локальные файлы, не открывая остальные."""
    for entry in manifest["files"]:
        path = destination / str(entry["path"])
        if not path.is_file() or path.is_symlink() or path.stat().st_size != int(entry["bytes"]):
            raise ValueError("snapshot file missing or has an invalid size")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != str(entry["sha256"]):
            raise ValueError("snapshot checksum mismatch")


def prepare(destination: Path) -> None:
    """Атомарно подготовить проверенный snapshot и сохранить имеющуюся папку."""
    with MANIFEST.open("r", encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError("destination must be a real directory")
        verify_snapshot(destination, manifest)
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".gigaam-download-", dir=destination.parent))
    try:
        for entry in manifest["files"]:
            _download_file(
                str(manifest["repository"]),
                str(manifest["revision"]),
                entry,
                staging / str(entry["path"]),
            )
        verify_snapshot(staging, manifest)
        staging.chmod(0o555)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            staging.chmod(0o755)
            shutil.rmtree(staging)


def main() -> int:
    """Разобрать путь назначения и подготовить закреплённый публичный snapshot."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--help", action="store_true")
    args, unknown = parser.parse_known_args()
    if args.help:
        print("Usage: prepare.py --model-dir ABSOLUTE_DESTINATION", file=sys.stderr)
        return 0
    if unknown or not Path(args.model_dir).is_absolute():
        print("GigaAM preparation requires one absolute --model-dir", file=sys.stderr)
        return 2
    try:
        prepare(Path(args.model_dir))
    except (OSError, ValueError, URLError, json.JSONDecodeError):
        print("GigaAM public model preparation failed verification or download", file=sys.stderr)
        return 1
    print("GigaAM public model snapshot is ready", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
