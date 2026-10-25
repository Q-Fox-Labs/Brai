#!/usr/bin/env python3
# ABOUTME: Подготавливает локальный HF dynamic-module cache без сети и credentials.
# ABOUTME: Проверяет четыре pinned model files и копирует только динамический Python code.
"""Create the pinned GigaAM Transformers dynamic-module cache offline."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()

    model = args.model_dir.resolve(strict=True)
    cache = args.cache_dir.absolute()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if model.name != "gigaam_pytorch" or cache.exists() or cache.is_symlink():
        raise SystemExit("model basename or empty cache destination mismatch")
    if os.environ.get("HF_MODULES_CACHE") != str(cache):
        raise SystemExit("HF_MODULES_CACHE must point to the private requested cache directory")
    if not os.environ.get("HF_HOME") or not os.environ.get("HOME") or not os.environ.get("TMPDIR"):
        raise SystemExit("private HOME, HF_HOME and TMPDIR are required")
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise SystemExit("offline Hugging Face mode is required")
    if any(os.environ.get(key) for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN")):
        raise SystemExit("Hugging Face credentials are not allowed during cache generation")
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != 4:
        raise SystemExit("expected the four-file pinned GigaAM source snapshot")
    expected = {entry["path"]: entry for entry in entries}
    if set(expected) != {"config.json", "modeling_gigaam.py", "pytorch_model.bin", "tokenizer.model"}:
        raise SystemExit("unexpected GigaAM source manifest")
    model_entries = list(model.iterdir())
    actual_names = {path.name for path in model_entries if path.is_file() and not path.is_symlink()}
    if actual_names != set(expected) or any(path.is_symlink() for path in model_entries):
        raise SystemExit("model snapshot contains unexpected files or symlinks")
    for name, entry in expected.items():
        path = model / name
        if path.stat().st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            raise SystemExit(f"GigaAM snapshot mismatch: {name}")

    from transformers.dynamic_module_utils import get_cached_module_file

    get_cached_module_file(
        str(model),
        "modeling_gigaam.py",
        force_download=False,
        resume_download=False,
        proxies=None,
        token=False,
        revision=None,
        local_files_only=True,
    )
    module_dir = cache / "transformers_modules" / "gigaam_pytorch"
    if not module_dir.is_dir() or not (module_dir / "modeling_gigaam.py").is_file():
        raise SystemExit("Transformers did not create the expected local dynamic module")
    for path in list(module_dir.rglob("*")):
        if path.is_symlink():
            raise SystemExit("dynamic-module cache contains a symlink")
        if path.is_file() and path.suffix == ".pyc":
            path.unlink()
    for directory in sorted((p for p in module_dir.rglob("*") if p.is_dir()), reverse=True):
        if directory.name == "__pycache__":
            shutil.rmtree(directory)
    if any(path.suffix == ".pyc" for path in cache.rglob("*")):
        raise SystemExit("bytecode remains in dynamic-module cache")
    print("offline dynamic-module cache prepared", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
