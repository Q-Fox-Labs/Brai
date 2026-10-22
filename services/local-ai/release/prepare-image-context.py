#!/usr/bin/env python3
# ABOUTME: Собирает Local AI Docker context из конкретного source revision и runtime manifest.
# ABOUTME: Компилирует TypeScript в staging, проверяет payload и не включает внешние model weights.
"""Assemble a deterministic, fail-closed Docker context from verified inputs.

The Ansible producer supplies a JSON inventory for already prepared portable
runtime files. This program never installs packages, downloads data, or copies
model weights. See README.md for the input schema and immutable requirements.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath


PRODUCT_FILES = (
    "services/local-ai/package.json",
    "services/local-ai/CONTRACT.md",
    "services/local-ai/asyncapi.yaml",
    "services/local-ai/contracts",
    "services/local-ai/migrations",
    "services/local-ai/profiles",
    "services/local-ai/schemas",
    "services/local-ai/src",
    "services/local-ai/runners/gigaam/__init__.py",
    "services/local-ai/runners/gigaam/longform.py",
    "services/local-ai/runners/gigaam/model_manifest.json",
    "services/local-ai/runners/gigaam/openrpc.json",
    "services/local-ai/runners/gigaam/prepare.py",
    "services/local-ai/runners/gigaam/requirements.in",
    "services/local-ai/runners/gigaam/requirements.lock",
    "services/local-ai/runners/gigaam/rpc.py",
    "services/local-ai/runners/gigaam/runner.py",
    "services/local-ai/runners/gigaam/schemas.json",
    "services/local-ai/runners/gigaam/vad_manifest.json",
    "services/local-ai/runners/llama_cpp/verify.mjs",
    "services/local-ai/runners/silero/runner.py",
    "services/local-ai/runners/silero/schemas.json",
    "services/local-ai/runners/silero/openrpc.json",
)
EXCLUDED_PARTS = {"tests", "__pycache__", ".pytest_cache", ".mypy_cache"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}
LOCK_SHA256 = "840176c57ae94bb8ed8b75117f36e973ddb38a8dc02ad8cf11ef1d0a13fc230e"
LLAMA_IMAGE = "ghcr.io/ggml-org/llama.cpp@sha256:7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571"
MODEL_REVISION = "cec030b4c4f35d928e4a9044a3bdb29ebd499fac"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def safe_relative(value: str) -> PurePosixPath:
    rel = PurePosixPath(value)
    if rel.is_absolute() or not rel.parts or any(part in {"", ".", ".."} for part in rel.parts):
        raise ValueError(f"unsafe relative path: {value}")
    return rel


def copy_regular(source: Path, target: Path, expected_sha: str | None = None, expected_size: int | None = None) -> dict[str, object]:
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"input is not a regular file: {source}")
    actual_sha = digest(source)
    if expected_sha is not None and actual_sha != expected_sha:
        raise ValueError(f"input SHA-256 mismatch: {source}")
    if expected_size is not None and info.st_size != expected_size:
        raise ValueError(f"input size mismatch: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    mode = stat.S_IMODE(info.st_mode)
    target.chmod(mode)
    return {"sha256": actual_sha, "bytes": info.st_size, "mode": f"{mode:04o}"}


def validate_runtime_provenance(entries: list[dict[str, object]], provenance: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    by_source = {item["destination"]: item for item in provenance}
    if len(by_source) != len(provenance):
        raise ValueError("runtime inventory has duplicate provenance destinations")
    sources: set[str] = set()
    destinations: set[str] = set()
    for item in entries:
        source_rel = safe_relative(item["source"])
        sources.add(source_rel.as_posix())
        destination_rel = safe_relative(item["destination"])
        expected = source_rel.as_posix() if source_rel.parts[0] == "app" else f"runtime/{source_rel.as_posix()}"
        if destination_rel.as_posix() != expected:
            raise ValueError("runtime inventory destination does not match the canonical image layout")
        destinations.add(destination_rel.as_posix())
    if len(sources) != len(entries) or len(destinations) != len(entries) or set(by_source) != sources:
        raise ValueError("runtime inventory contains duplicate destinations or mismatched provenance")
    for item in entries:
        receipt = by_source[item["source"]]
        if any(item[key] != receipt[key] for key in ("bytes", "sha256", "mode")):
            raise ValueError("runtime inventory entry differs from file provenance")
    return by_source


def copy_runtime_inventory(runtime: Path, payload: Path, entries: list[dict[str, object]], provenance_by_source: dict[str, dict[str, object]]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for item in entries:
        src_rel = safe_relative(item["source"])
        dst_rel = safe_relative(item["destination"])
        if dst_rel.parts[0] not in {"runtime", "app"} or (dst_rel.parts[0] == "app" and dst_rel.parts[:4] != ("app", "services", "local-ai", "node_modules")):
            raise ValueError("runtime inventory destination is outside approved runtime/cache/app dependency roots")
        source_file = runtime.joinpath(*src_rel.parts)
        if not source_file.resolve(strict=True).is_relative_to(runtime):
            raise ValueError("runtime input escaped its declared root")
        row = copy_regular(source_file, payload.joinpath(*dst_rel.parts), item["sha256"], item["bytes"])
        row["path"] = dst_rel.as_posix()
        receipt = provenance_by_source[src_rel.as_posix()]
        row["source"] = receipt["source"]
        if row["sha256"] != receipt["sha256"] or row["bytes"] != receipt["bytes"] or row["mode"] != receipt["mode"]:
            raise ValueError(f"runtime provenance checksum mismatch: {dst_rel}")
        if item.get("mode") and row["mode"] != item["mode"]:
            raise ValueError(f"runtime mode mismatch: {dst_rel}")
        rows.append(row)
    return rows


def walk_product(source: Path, relative: str):
    root = source / relative
    if not root.exists() or root.is_symlink():
        raise ValueError(f"required product input missing or symlinked: {relative}")
    if root.is_file():
        yield root, relative
        return
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(source).as_posix()
        if any(part in EXCLUDED_PARTS for part in PurePosixPath(rel).parts) or path.suffix in EXCLUDED_SUFFIXES:
            continue
        if path.is_symlink():
            raise ValueError(f"product tree contains symlink: {rel}")
        if path.is_file():
            yield path, rel


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--runtime-manifest", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    source = args.source.resolve(strict=True)
    runtime = args.runtime_root.resolve(strict=True)
    output = args.output.absolute()
    if len(args.source_revision) != 40 or any(c not in "0123456789abcdef" for c in args.source_revision):
        raise ValueError("source revision must be a full lowercase Git object id")
    head = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], check=True, text=True, capture_output=True).stdout.strip()
    if head != args.source_revision:
        raise ValueError("source checkout HEAD does not equal the explicit full source revision")
    status = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=all"],
        check=True,
        text=True,
        capture_output=True,
    ).stdout
    if status:
        raise ValueError("product checkout is dirty; refusing to bind changed files to a committed revision")
    if output.exists() or output.is_symlink():
        raise ValueError("output must not exist; refusing to overwrite a previous context")
    inventory = json.loads(args.runtime_manifest.read_text(encoding="utf-8"))
    if inventory.get("sourceRevision") != args.source_revision:
        raise ValueError("runtime inventory is not bound to the requested full source revision")
    if inventory.get("pythonLockSha256") != LOCK_SHA256 or inventory.get("llamaImage") != LLAMA_IMAGE:
        raise ValueError("runtime inventory does not identify the accepted Python lock and llama image")
    if inventory.get("baseImage") != "ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4":
        raise ValueError("runtime inventory does not bind the accepted Ubuntu base image")
    if inventory.get("glibcAbi") != "Ubuntu 24.04 / glibc 2.39" or inventory.get("ffmpegPackageVersion") != "7:6.1.1-3ubuntu5":
        raise ValueError("runtime inventory ABI or FFmpeg build does not match the accepted inputs")
    selection = inventory.get("torchcodecAbiSelection")
    if not isinstance(selection, dict) or selection.get("activeFfmpegMajor") != 6 or len(selection.get("activeFiles", [])) != 3 or len(selection.get("inactiveFallbackFiles", [])) != 9:
        raise ValueError("runtime inventory lacks the pinned TorchCodec FFmpeg-6 selection and fallback accounting")
    torio_selection = inventory.get("torioAbiSelection")
    if not isinstance(torio_selection, dict) or torio_selection.get("activeFfmpegMajor") != 6 or len(torio_selection.get("activeFiles", [])) != 2 or len(torio_selection.get("inactiveFallbackFiles", [])) != 4:
        raise ValueError("runtime inventory lacks the pinned torio FFmpeg-6 selection and fallback accounting")
    torchaudio_selection = inventory.get("torchaudioAbiSelection")
    optional_sox = torchaudio_selection.get("optionalSoxBackend") if isinstance(torchaudio_selection, dict) else None
    if not isinstance(torchaudio_selection, dict) or len(torchaudio_selection.get("activeFiles", [])) != 2 or not isinstance(optional_sox, dict) or optional_sox.get("active") is not False or optional_sox.get("requiredLibrary") != "libsox.so" or len(optional_sox.get("files", [])) != 2:
        raise ValueError("runtime inventory lacks exact torchaudio core and optional-SoX accounting")
    if inventory.get("nodePackageLockSha256") != digest(source / "package-lock.json"):
        raise ValueError("runtime inventory Node dependency lock differs from this source revision")
    llama_manifest_sha = inventory.get("llamaManifestSha256", "")
    if len(llama_manifest_sha) != 64 or any(char not in "0123456789abcdef" for char in llama_manifest_sha):
        raise ValueError("runtime inventory lacks the exact pinned llama source manifest hash")
    if not isinstance(inventory.get("pythonDistributions"), dict) or len(inventory["pythonDistributions"]) != 98:
        raise ValueError("runtime inventory lacks the complete 98-package Python closure")
    entries = inventory.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("runtime inventory must contain an explicit file list")
    provenance = inventory.get("provenance")
    if not isinstance(provenance, list) or len(provenance) != len(entries):
        raise ValueError("runtime inventory provenance must identify every staged file")
    provenance_by_destination = validate_runtime_provenance(entries, provenance)
    expected_runtime_sources: set[str] = set()
    for item in entries:
        source_rel = safe_relative(item["source"])
        expected_runtime_sources.add(source_rel.as_posix())
    actual_runtime_sources: set[str] = set()
    for path in runtime.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"runtime root contains a symlink: {path.relative_to(runtime)}")
        if path.is_file():
            actual_runtime_sources.add(path.relative_to(runtime).as_posix())
    if actual_runtime_sources != expected_runtime_sources:
        raise ValueError("runtime root contains missing or uninventoried files")
    python_rel = safe_relative(inventory.get("cachePythonExecutable", ""))
    if python_rel.parts[:3] != ("gigaam_pytorch", ".venv", "bin") or python_rel.name not in {"python", "python3", "python3.12"}:
        raise ValueError("runtime inventory must identify the managed GigaAM CPU venv interpreter")
    python_executable = Path(inventory.get("cachePythonExecutableHost", ""))
    if python_executable != Path("/opt/brai/local-ai/runtime/gigaam_pytorch/.venv/bin/python"):
        raise ValueError("cache generation must use the explicitly accepted managed CPU venv path")
    if not python_executable.is_file() or not os.access(python_executable, os.X_OK):
        raise ValueError("managed CPU venv interpreter is missing or not executable")
    if digest(python_executable) != inventory.get("cachePythonExecutableHostSha256"):
        raise ValueError("managed CPU venv interpreter checksum differs from the runtime receipt")
    model_manifest = json.loads((source / "services/local-ai/runners/gigaam/model_manifest.json").read_text(encoding="utf-8"))
    if model_manifest.get("revision") != MODEL_REVISION:
        raise ValueError("product model manifest revision mismatch")
    model = args.model_dir.resolve(strict=True)
    if model.name != "gigaam_pytorch":
        raise ValueError("model source must use the canonical gigaam_pytorch directory name")
    expected_model = {entry["path"]: entry for entry in model_manifest["files"]}
    if set(expected_model) != {"config.json", "modeling_gigaam.py", "pytorch_model.bin", "tokenizer.model"}:
        raise ValueError("unexpected pinned model manifest file set")
    model_entries = list(model.iterdir())
    if {path.name for path in model_entries} != set(expected_model) or any(path.is_symlink() or not path.is_file() for path in model_entries):
        raise ValueError("model source directory contains unexpected entries")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        payload = staging / "payload"
        rows: list[dict[str, object]] = []
        node = runtime / "node-v24.21.0-linux-x64/bin/node"
        if not node.is_file() or node.is_symlink():
            raise ValueError("portable Node runtime executable is missing")
        typescript_path = source / "node_modules/typescript"
        typescript_root = typescript_path.resolve(strict=True)
        shared_dependency_root = Path("/srv/projects/brai/node_modules").resolve(strict=True)
        if not typescript_root.is_relative_to(shared_dependency_root):
            raise ValueError("TypeScript compiler is not from the accepted prepared dependency store")
        typescript_package = json.loads((typescript_root / "package.json").read_text(encoding="utf-8"))
        lockfile = json.loads((source / "package-lock.json").read_text(encoding="utf-8"))
        if typescript_package.get("version") != "5.9.3" or lockfile["packages"]["node_modules/typescript"].get("version") != "5.9.3":
            raise ValueError("TypeScript build tool does not match the product lock")
        compiler = (typescript_root / "bin/tsc").resolve(strict=True)
        if not compiler.is_relative_to(typescript_root):
            raise ValueError("TypeScript compiler path escapes its locked package")
        compiled_dist = staging / "compiled-dist"
        compiled_dist.mkdir()
        build_tmp = staging / "build-tmp"
        build_tmp.mkdir()
        build_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LD_LIBRARY_PATH": str(runtime / "system-libs"),
            "HOME": str(build_tmp),
            "TMPDIR": str(build_tmp),
            "TEMP": str(build_tmp),
            "TMP": str(build_tmp),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "NODE_ENV": "production",
        }
        subprocess.run(
            [
                str(node), str(compiler),
                "--project", str(source / "services/local-ai/tsconfig.json"),
                "--outDir", str(compiled_dist),
                "--incremental", "false",
            ],
            check=True,
            cwd=source,
            env=build_env,
            timeout=120,
        )
        for relative in PRODUCT_FILES:
            for src, rel in walk_product(source, relative):
                row = copy_regular(src, payload / "app" / rel)
                row["path"] = f"app/{rel}"
                row["source"] = f"source:{args.source_revision}/{rel}"
                rows.append(row)
        if not any(compiled_dist.rglob("*.js")):
            raise ValueError("TypeScript compilation produced no JavaScript files")
        for src in sorted(compiled_dist.rglob("*")):
            if src.is_symlink():
                raise ValueError("compiled product output contains a symlink")
            if src.is_file():
                rel = src.relative_to(compiled_dist).as_posix()
                row = copy_regular(src, payload / "app/services/local-ai/dist" / rel)
                row["path"] = f"app/services/local-ai/dist/{rel}"
                row["source"] = f"tsc:{args.source_revision}/{rel}"
                rows.append(row)
        for entry in expected_model.values():
            path = model / entry["path"]
            if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
                raise ValueError(f"pinned model source verification failed: {entry['path']}")
        rows.extend(copy_runtime_inventory(runtime, payload, entries, provenance_by_destination))

        vendor_data = inventory.get("vendorData")
        if not isinstance(vendor_data, list) or len(vendor_data) != 5:
            raise ValueError("runtime inventory lacks exact allowlisted Python vendor data")
        expected_vendor_paths = {
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/distutils-precedence.pth",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nfkc_cf.bin",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nmt_nfkc.bin",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nmt_nfkc_cf.bin",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/sentencepiece/package_data/nfkc.bin",
        }
        if {item.get("path") for item in vendor_data} != expected_vendor_paths:
            raise ValueError("runtime inventory vendor data paths differ from the exact allowlist")
        allowed_vendor_files = []
        for item in vendor_data:
            source_rel = safe_relative(item["path"])
            if source_rel.parts[:5] != ("gigaam_pytorch", ".venv", "lib", "python3.12", "site-packages"):
                raise ValueError("vendor data allowlist path escapes Python site-packages")
            destination = f"runtime/{source_rel.as_posix()}"
            row = next((candidate for candidate in rows if candidate["path"] == destination), None)
            if row is None or row["sha256"] != item["sha256"] or row["bytes"] != item["bytes"]:
                raise ValueError(f"allowlisted vendor data is absent or differs from runtime inventory: {destination}")
            allowed_vendor_files.append({"path": destination, "sha256": row["sha256"], "bytes": row["bytes"]})
        omitted_assets = inventory.get("omittedVendorAssets")
        if not isinstance(omitted_assets, list) or len(omitted_assets) != 27:
            raise ValueError("runtime inventory lacks complete exact vendor asset exclusion accounting")

        cache_root = payload / "hf-modules-cache"
        cache_home = staging / "cache-home"
        cache_tmp = staging / "cache-tmp"
        cache_home.mkdir()
        cache_tmp.mkdir()
        (cache_home / "huggingface").mkdir()
        release_descriptor = json.loads((source / "services/local-ai/release.json").read_text(encoding="utf-8"))
        native_library_dirs = release_descriptor.get("runtimePayload", {}).get("nativeLibrarySearchDirectories")
        if not isinstance(native_library_dirs, list) or not native_library_dirs or any(not isinstance(item, str) for item in native_library_dirs):
            raise ValueError("release descriptor lacks native runtime library search directories")
        native_library_paths = [runtime / safe_relative(item) for item in native_library_dirs]
        if any(not path.is_dir() or path.is_symlink() for path in native_library_paths):
            raise ValueError("native runtime library search directory is missing or unsafe")
        offline_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LD_LIBRARY_PATH": ":".join(map(str, native_library_paths)) + ":/usr/lib/x86_64-linux-gnu:/lib/x86_64-linux-gnu",
            "HOME": str(cache_home),
            "HF_HOME": str(cache_home / "huggingface"),
            "HF_MODULES_CACHE": str(cache_root),
            "TMPDIR": str(cache_tmp),
            "TEMP": str(cache_tmp),
            "TMP": str(cache_tmp),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
        }
        subprocess.run(
            [
                str(python_executable),
                str(source / "services/local-ai/release/prepare-transformers-cache.py"),
                "--model-dir",
                str(model),
                "--cache-dir",
                str(cache_root),
                "--manifest",
                str(source / "services/local-ai/runners/gigaam/model_manifest.json"),
            ],
            check=True,
            env=offline_env,
            timeout=120,
        )
        for path in sorted(cache_root.rglob("*")):
            if path.is_symlink():
                raise ValueError("generated HF cache contains a symlink")
            if path.is_file():
                relative = path.relative_to(payload).as_posix()
                rows.append({
                    "path": relative,
                    "source": f"generated-transformers-cache:{MODEL_REVISION}/{path.relative_to(cache_root).as_posix()}",
                    "sha256": digest(path),
                    "bytes": path.stat().st_size,
                    "mode": f"{stat.S_IMODE(path.stat().st_mode):04o}",
                })
        if not any(str(row["path"]).endswith(".py") for row in rows if str(row["path"]).startswith("hf-modules-cache/")):
            raise ValueError("offline Transformers cache contains no dynamic-module Python source")
        for docker_file in ("Dockerfile", "Dockerfile.dockerignore", "release.json"):
            copy_regular(source / "services/local-ai" / docker_file, staging / "services/local-ai" / docker_file)
        manifest = {
            "formatVersion": 1,
            "sourceRevision": args.source_revision,
            "runtimeManifestSha256": digest(args.runtime_manifest),
            "pythonLockSha256": LOCK_SHA256,
            "llamaImage": LLAMA_IMAGE,
            "modelSourceRevision": MODEL_REVISION,
            "allowedVendorFiles": allowed_vendor_files,
            "omittedVendorAssets": inventory["omittedVendorAssets"],
            "torchcodecAbiSelection": inventory["torchcodecAbiSelection"],
            "torioAbiSelection": inventory["torioAbiSelection"],
            "torchaudioAbiSelection": inventory["torchaudioAbiSelection"],
            "modelIncluded": False,
            "files": sorted(rows, key=lambda row: str(row["path"])),
            "recipes": {
                name: {
                    "sha256": digest(source / "services/local-ai" / name),
                    "bytes": (source / "services/local-ai" / name).stat().st_size,
                    "mode": f"{stat.S_IMODE((source / 'services/local-ai' / name).stat().st_mode):04o}",
                }
                for name in ("Dockerfile", "Dockerfile.dockerignore", "release.json")
            },
        }
        inventory_path = payload / "SHA256SUMS"
        inventory_path.write_text("".join(f"{row['sha256']}  {row['path']}\n" for row in manifest["files"]), encoding="utf-8")
        (staging / "payload-inputs.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        shutil.rmtree(compiled_dist)
        shutil.rmtree(build_tmp)
        shutil.rmtree(cache_home)
        shutil.rmtree(cache_tmp)
        if any(path.is_symlink() for path in staging.rglob("*")):
            raise ValueError("final context contains a symlink")
        os.replace(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(f"context staged for {args.source_revision}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"release context rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
