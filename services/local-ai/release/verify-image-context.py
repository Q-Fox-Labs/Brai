#!/usr/bin/env python3
# ABOUTME: Проверяет read-only полный SHA-256 inventory portable image payload.
# ABOUTME: Отклоняет непроверенные файлы, credentials и внешние model/audio data.
"""Verify the complete on-disk Docker payload inventory without modifying it."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import sys
from pathlib import Path, PurePosixPath


FORBIDDEN_NAMES = {".env", ".env.local", "hf_token", "huggingface_token", "credentials"}
FORBIDDEN_SUFFIXES = {".gguf", ".wav", ".flac", ".mp3", ".pyc", ".pyo", ".pt", ".safetensors"}
VENDOR_DATA_PATHS = {
    "runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/distutils-precedence.pth",
    "runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nfkc_cf.bin",
    "runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nmt_nfkc.bin",
    "runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nmt_nfkc_cf.bin",
    "runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nfkc.bin",
}
ALLOWED_CONTEXT_FILES = {
    "payload-inputs.json",
    "services/local-ai/Dockerfile",
    "services/local-ai/Dockerfile.dockerignore",
    "services/local-ai/release.json",
}
NATIVE_LIBRARY_SEARCH_DIRECTORIES = [
    "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/app",
    "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/system",
    "system-libs",
    "python/lib",
    "python/lib/python3.12/lib-dynload",
    "gigaam_pytorch/.venv/lib/python3.12/site-packages/torch/lib",
    "gigaam_pytorch/.venv/lib/python3.12/site-packages/torchcodec",
    "gigaam_pytorch/.venv/lib/python3.12/site-packages/torio/lib",
    "gigaam_pytorch/.venv/lib/python3.12/site-packages/torchaudio/lib",
]


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True, type=Path)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    if args.context.is_symlink():
        raise ValueError("context root must not be a symlink")
    context = args.context.resolve(strict=True)
    payload = context / "payload"
    inventory = json.loads((context / "payload-inputs.json").read_text(encoding="utf-8"))
    if inventory.get("sourceRevision") != args.source_revision:
        raise ValueError("context source revision mismatch")
    if inventory.get("modelIncluded") is not False:
        raise ValueError("external model data must not be included")
    vendor_files = inventory.get("allowedVendorFiles")
    if not isinstance(vendor_files, list) or {item.get("path") for item in vendor_files} != VENDOR_DATA_PATHS:
        raise ValueError("context does not contain the exact narrow vendor-data allowlist")
    allowed_vendor = {item["path"]: item for item in vendor_files}
    rows = inventory.get("files")
    if not isinstance(rows, list) or not rows:
        raise ValueError("empty payload inventory")
    expected: dict[str, dict[str, object]] = {}
    for row in rows:
        name = row["path"]
        rel = PurePosixPath(name)
        if rel.is_absolute() or ".." in rel.parts or name in expected:
            raise ValueError("unsafe or duplicate inventory path")
        if row["path"] != name:
            raise ValueError("inventory row path mismatch")
        if name in expected:
            raise ValueError("duplicate payload inventory path")
        expected[name] = row
    sums: dict[str, str] = {}
    for line in (payload / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        if name in sums:
            raise ValueError("duplicate SHA256SUMS entry")
        sums[name] = digest
    if sums != {name: row["sha256"] for name, row in expected.items()}:
        raise ValueError("payload.SHA256SUMS differs from the provenance inventory")
    actual: set[str] = set()
    for path in context.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"context contains symlink: {path.relative_to(context)}")
        if not path.is_dir() and not path.is_file():
            raise ValueError(f"context contains a non-regular entry: {path.relative_to(context)}")
    for path in payload.rglob("*"):
        rel = path.relative_to(payload).as_posix()
        if path.is_file() and rel != "SHA256SUMS":
            lowered = path.name.lower()
            if lowered in FORBIDDEN_NAMES or lowered.endswith(".env") or lowered.startswith(".env.") or path.suffix.lower() in FORBIDDEN_SUFFIXES:
                raise ValueError(f"payload contains forbidden data or credential file: {rel}")
            if path.suffix.lower() in {".bin", ".pth"}:
                allowlisted = allowed_vendor.get(rel)
                if allowlisted is None or sha256(path) != allowlisted.get("sha256") or path.stat().st_size != allowlisted.get("bytes"):
                    raise ValueError(f"payload contains unapproved vendor binary data: {rel}")
            if lowered in {"config.json", "modeling_gigaam.py", "pytorch_model.bin", "tokenizer.model", "model.safetensors", "vad.model"} and rel.startswith("runtime/"):
                raise ValueError(f"payload contains a model source or weight file: {rel}")
            if not stat.S_ISREG(path.stat().st_mode):
                raise ValueError(f"payload entry is not a regular file: {rel}")
            if PurePosixPath(rel).parts[0] not in {"app", "runtime", "hf-modules-cache"}:
                raise ValueError(f"payload path is outside approved roots: {rel}")
            actual.add(rel)
            row = expected.get(rel)
            if row is None or sha256(path) != row["sha256"] or path.stat().st_size != row["bytes"] or f"{stat.S_IMODE(path.stat().st_mode):04o}" != row["mode"]:
                raise ValueError(f"payload hash mismatch: {rel}")
    if actual != set(expected):
        raise ValueError("payload has missing or uninventoried files")
    if set(allowed_vendor) - actual:
        raise ValueError("one or more required allowlisted vendor files are missing")
    selection = inventory.get("torchcodecAbiSelection")
    if not isinstance(selection, dict) or selection.get("activeFfmpegMajor") != 6 or len(selection.get("activeFiles", [])) != 3 or len(selection.get("inactiveFallbackFiles", [])) != 9:
        raise ValueError("context lacks exact TorchCodec FFmpeg-6 selection accounting")
    torio_selection = inventory.get("torioAbiSelection")
    if not isinstance(torio_selection, dict) or torio_selection.get("activeFfmpegMajor") != 6 or len(torio_selection.get("activeFiles", [])) != 2 or len(torio_selection.get("inactiveFallbackFiles", [])) != 4:
        raise ValueError("context lacks exact torio FFmpeg-6 selection accounting")
    torchaudio_selection = inventory.get("torchaudioAbiSelection")
    optional_sox = torchaudio_selection.get("optionalSoxBackend") if isinstance(torchaudio_selection, dict) else None
    if not isinstance(torchaudio_selection, dict) or len(torchaudio_selection.get("activeFiles", [])) != 2 or not isinstance(optional_sox, dict) or optional_sox.get("active") is not False or optional_sox.get("requiredLibrary") != "libsox.so" or len(optional_sox.get("files", [])) != 2:
        raise ValueError("context lacks exact torchaudio core and optional-SoX accounting")
    actual_context_files = {path.relative_to(context).as_posix() for path in context.rglob("*") if path.is_file()}
    if actual_context_files != ALLOWED_CONTEXT_FILES | {f"payload/{name}" for name in expected} | {"payload/SHA256SUMS"}:
        raise ValueError("context contains an unapproved or missing file")
    recipes = inventory.get("recipes")
    if not isinstance(recipes, dict) or set(recipes) != {"Dockerfile", "Dockerfile.dockerignore", "release.json"}:
        raise ValueError("recipe file inventory is missing or incomplete")
    for name, receipt in recipes.items():
        path = context / "services/local-ai" / name
        if sha256(path) != receipt["sha256"] or path.stat().st_size != receipt["bytes"] or f"{stat.S_IMODE(path.stat().st_mode):04o}" != receipt["mode"]:
            raise ValueError(f"release recipe mismatch: {name}")
    dockerfile = json.loads((context / "services/local-ai/release.json").read_text(encoding="utf-8"))
    if dockerfile.get("source", {}).get("revisionBuildArgument") != "BRAI_SOURCE_REVISION":
        raise ValueError("release descriptor does not bind the full source revision")
    base = dockerfile.get("image", {}).get("baseImage", {})
    if base.get("reference") != "ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4" or dockerfile.get("image", {}).get("copyOnly") is not True:
        raise ValueError("release descriptor base or copy-only contract mismatch")
    native_dirs = dockerfile.get("runtimePayload", {}).get("nativeLibrarySearchDirectories")
    if native_dirs != NATIVE_LIBRARY_SEARCH_DIRECTORIES:
        raise ValueError("release descriptor native library search directories differ from the supported runtime set")
    dockerfile_text = (context / "services/local-ai/Dockerfile").read_text(encoding="utf-8")
    ld_lines = [line.strip().rstrip("\\") for line in dockerfile_text.splitlines() if line.strip().startswith("LD_LIBRARY_PATH=")]
    docker_dirs = ld_lines[0].split("=", 1)[1].split(":") if len(ld_lines) == 1 else []
    expected_docker_dirs = [f"/opt/brai/local-ai/runtime/{relative}" for relative in NATIVE_LIBRARY_SEARCH_DIRECTORIES]
    if docker_dirs != expected_docker_dirs:
        raise ValueError("Dockerfile LD_LIBRARY_PATH differs from the declared native runtime directories")
    print(json.dumps({"sourceRevision": args.source_revision, "payloadFiles": len(actual), "verified": True}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"image context verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
