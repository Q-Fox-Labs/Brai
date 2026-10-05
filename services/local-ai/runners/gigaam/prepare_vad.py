#!/usr/bin/env python3
# ABOUTME: Атомарно подготавливает закреплённый gated pyannote VAD snapshot.
# ABOUTME: Токен передаётся только через окружение Ansible и не попадает в вывод.

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
from urllib.request import HTTPRedirectHandler, Request, build_opener

from longform import VAD_MANIFEST, LongformUnavailable, _manifest_at, verify_vad_snapshot


ALLOWED_HOSTS = ("huggingface.co", "hf.co")


def _safe_https_url(url: str) -> bool:
    """Проверить HTTPS адрес Hugging Face или официального file redirect host."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
        and any(host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_HOSTS)
    )


class _SafeRedirectHandler(HTTPRedirectHandler):
    """Отклонить посторонние redirect и снять bearer auth при смене origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        """Передать управление только HTTPS redirect на разрешённый HF домен."""
        if not _safe_https_url(newurl):
            return None
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is None:
            return None
        previous = urlparse(req.full_url)
        target = urlparse(newurl)
        if (previous.scheme, previous.hostname, previous.port) != (
            target.scheme,
            target.hostname,
            target.port,
        ):
            redirected.remove_header("Authorization")
        return redirected


def _download_file(
    repository: str,
    revision: str,
    token: str,
    entry: dict[str, object],
    target: Path,
) -> None:
    """Загрузить один закреплённый артефакт и проверить байты с SHA-256."""
    filename = str(entry["path"])
    if Path(filename).name != filename:
        raise ValueError("invalid pinned file path")
    expected_bytes = int(entry["bytes"])
    expected_sha = str(entry["sha256"])
    url = (
        f"https://huggingface.co/{repository}/resolve/{revision}/"
        f"{quote(filename, safe='')}"
    )
    if not _safe_https_url(url):
        raise ValueError("invalid pinned download host")
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "Brai-local-ai/1",
        },
    )
    digest = hashlib.sha256()
    actual_bytes = 0
    opener = build_opener(_SafeRedirectHandler())
    with opener.open(request, timeout=60) as response, target.open("xb") as output:
        if not _safe_https_url(response.geturl()):
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


def prepare(destination: Path, token: str | None) -> None:
    """Идемпотентно опубликовать только целиком проверенный VAD snapshot."""
    manifest = _manifest_at(VAD_MANIFEST)
    if destination.exists() or destination.is_symlink():
        verify_vad_snapshot(destination)
        return
    if not token:
        raise ValueError("authorized model access is unavailable")

    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=".pyannote-vad-download-", dir=destination.parent)
    )
    try:
        for entry in manifest["files"]:
            _download_file(
                str(manifest["repository"]),
                str(manifest["revision"]),
                token,
                entry,
                staging / str(entry["path"]),
            )
        manifest_bytes = VAD_MANIFEST.read_bytes()
        with (staging / "manifest.json").open("xb") as output:
            output.write(manifest_bytes)
            output.flush()
            os.fsync(output.fileno())
        (staging / "manifest.json").chmod(0o444)
        verify_vad_snapshot(staging)
        staging.chmod(0o555)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            staging.chmod(0o755)
            shutil.rmtree(staging)


def main() -> int:
    """Прочитать токен Ansible из окружения и подготовить локальный snapshot."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--help", action="store_true")
    args, unknown = parser.parse_known_args()
    if args.help:
        print("Usage: prepare_vad.py --model-dir ABSOLUTE_DESTINATION", file=sys.stderr)
        return 0
    destination = Path(args.model_dir)
    if unknown or not destination.is_absolute():
        print("VAD preparation requires one absolute --model-dir", file=sys.stderr)
        return 2
    try:
        prepare(destination, os.environ.get("HF_TOKEN"))
    except (OSError, ValueError, URLError, LongformUnavailable, json.JSONDecodeError):
        print("Pinned pyannote VAD preparation failed verification or authorized download", file=sys.stderr)
        return 1
    print("Pinned pyannote VAD snapshot is ready", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
