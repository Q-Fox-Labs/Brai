#!/usr/bin/env python3
# ABOUTME: Материализует portable Local AI runtime из уже подготовленных pinned roots.
# ABOUTME: Создаёт полный file/hash/mode inventory и отклоняет незамкнутый ELF ABI.
"""Materialize a portable CPU runtime and a hash-bound inventory from accepted roots.

This is a source candidate for Ansible orchestration. It performs no installs,
network access, model copy, or Docker operation. It fails closed on unresolved
ELF dependencies, unapproved ABI, symlinks escaping declared roots, or package
inventory drift.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


LOCK_SHA = "840176c57ae94bb8ed8b75117f36e973ddb38a8dc02ad8cf11ef1d0a13fc230e"
LLAMA_IMAGE = "ghcr.io/ggml-org/llama.cpp@sha256:7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571"
BASE_REF = "ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4"
SYSTEM_BASE_NEEDED = {
    "ld-linux-x86-64.so.2", "libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2",
    "librt.so.1", "libutil.so.1", "libresolv.so.2",
}
SITE_PACKAGES = "gigaam_pytorch/.venv/lib/python3.12/site-packages"
VENDOR_DATA = {
    f"{SITE_PACKAGES}/distutils-precedence.pth": (151, "2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224"),
    f"{SITE_PACKAGES}/sentencepiece/package_data/nfkc_cf.bin": (247028, "60833ec11201446659c3549c183b18f024c4007628cc6b3a4e91ae007697b826"),
    f"{SITE_PACKAGES}/sentencepiece/package_data/nmt_nfkc.bin": (240007, "79372c41389c2b9b29bc171017ab5400e352debd686b02670a42bec709015074"),
    f"{SITE_PACKAGES}/sentencepiece/package_data/nmt_nfkc_cf.bin": (247027, "22c292c76f503795f30c85d79d30a7f572fff4f49e00392d2d60f4f93e941a1e"),
    f"{SITE_PACKAGES}/sentencepiece/package_data/nfkc.bin": (240008, "52f11028ff8a7df3e009d94a8b6a54d4a8a17132efb4ccc1c9a0a41e432bd91e"),
}
OMITTED_VENDOR_ASSETS = {
    **{f"scipy/io/tests/data/{name}": "third-party test audio" for name in (
        "test-8000Hz-le-3ch-5S-64bit.wav", "test-44100Hz-be-1ch-4bytes.wav",
        "test-8000Hz-le-5ch-9S-5bit.wav", "test-48000Hz-2ch-64bit-float-le-wavex.wav",
        "test-8000Hz-le-2ch-1byteu.wav", "test-8000Hz-le-1ch-1byte-ulaw.wav",
        "test-8000Hz-le-3ch-5S-36bit.wav", "test-8000Hz-be-3ch-5S-24bit.wav",
        "test-8000Hz-le-3ch-5S-24bit-inconsistent.wav", "test-8000Hz-le-3ch-5S-53bit.wav",
        "test-44100Hz-2ch-32bit-float-be.wav", "test-44100Hz-le-1ch-4bytes-early-eof.wav",
        "test-44100Hz-le-1ch-4bytes.wav", "test-44100Hz-2ch-32bit-float-le.wav",
        "test-8000Hz-le-3ch-5S-24bit-rf64.wav", "test-44100Hz-le-1ch-4bytes-rf64.wav",
        "test-1234Hz-le-1ch-10S-20bit-extra.wav", "test-8000Hz-le-3ch-5S-45bit.wav",
        "test-8000Hz-le-4ch-9S-12bit.wav", "test-44100Hz-le-1ch-4bytes-incomplete-chunk.wav",
        "test-44100Hz-le-1ch-4bytes-early-eof-no-data.wav", "test-8000Hz-le-3ch-5S-24bit.wav",
    )},
    "pyannote/audio/sample/sample.wav": "third-party sample audio",
    "torchmetrics/functional/image/dists_models/weights.pt": "unused vision metric weights",
    "torchmetrics/functional/image/lpips_models/squeeze.pth": "unused vision metric weights",
    "torchmetrics/functional/image/lpips_models/vgg.pth": "unused vision metric weights",
    "torchmetrics/functional/image/lpips_models/alex.pth": "unused vision metric weights",
}
PYTHON_BASE_OMITTED_LINKS = {
    "config-3.12-x86_64-linux-gnu/libpython3.12.so": {
        "target": "../../x86_64-linux-gnu/libpython3.12.so.1",
        "resolvedPath": "/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0",
        "bytes": 9061000,
        "sha256": "1021f236227334ded6d1bbbc4bb6f5d933f793d8397c969896cfbdf03ce96223",
        "reason": "development linker alias; the accepted interpreter has no libpython DT_NEEDED entry",
    },
    "sitecustomize.py": {
        "target": "/etc/python3.12/sitecustomize.py",
        "resolvedPath": "/etc/python3.12/sitecustomize.py",
        "bytes": 155,
        "sha256": "43d81125d92376b1a69d53a71126a041cc9a18d8080e92dea0a2ae23be138b1e",
        "reason": "host apport exception hook is not part of the service runtime",
    },
}
LIBPYTHON_SONAME_LINK = {
    "target": "libpython3.12.so.1.0",
    "resolvedPath": "/usr/lib/x86_64-linux-gnu/libpython3.12.so.1.0",
    "bytes": 9061000,
    "sha256": "1021f236227334ded6d1bbbc4bb6f5d933f793d8397c969896cfbdf03ce96223",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(argv: list[str], **kwargs) -> str:
    result = subprocess.run(argv, check=True, text=True, capture_output=True, **kwargs)
    return result.stdout


def add_file(source: Path, destination: Path, rows: list[dict[str, object]], *, mode: int | None = None) -> None:
    if source.is_symlink():
        source = source.resolve(strict=True)
    if not source.is_file():
        raise ValueError(f"runtime input is not a file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    actual_mode = stat.S_IMODE(source.stat().st_mode) if mode is None else mode
    destination.chmod(actual_mode)
    rows.append({
        "source": str(source),
        "destination": destination.as_posix(),
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "mode": f"{actual_mode:04o}",
    })


def is_elf(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            return stream.read(4) == b"\x7fELF"
    except OSError:
        return False


def select_torchcodec_elfs(root: Path) -> tuple[list[Path], list[Path]]:
    files = sorted(path for path in root.rglob("*.so") if path.is_file())
    active = [path for path in files if path.name.endswith("6.so")]
    inactive = [path for path in files if path not in active]
    if len(active) != 3 or len(files) != 12 or len(inactive) != 9 or any(not path.name.endswith(("4.so", "5.so", "7.so")) for path in inactive):
        raise ValueError("TorchCodec wheel does not have the exact supported FFmpeg-6 and inactive fallback ELF set")
    if {path.name.removesuffix(".so")[:-1] for path in active} != {
        "libtorchcodec_core", "libtorchcodec_custom_ops", "libtorchcodec_pybind_ops",
    }:
        raise ValueError("TorchCodec FFmpeg-6 active ELF names differ from the supported set")
    return active, inactive


def select_torio_elfs(root: Path) -> tuple[list[Path], list[Path]]:
    expected = {
        f"{prefix}torio_ffmpeg{major}.so"
        for prefix in ("_", "lib")
        for major in (4, 5, 6)
    }
    actual = {path.name for path in root.glob("*.so") if path.is_file() and not path.is_symlink()}
    if actual != expected:
        raise ValueError("torio FFmpeg backend ELF set differs from the exact supported 4/5/6 inventory")
    active = sorted((root / "_torio_ffmpeg6.so", root / "libtorio_ffmpeg6.so"))
    inactive = sorted(path for path in root.glob("*.so") if path not in active)
    return active, inactive


def inventory_torchaudio_elfs(root: Path) -> tuple[list[Path], list[Path]]:
    expected = {"_torchaudio.so", "libtorchaudio.so", "_torchaudio_sox.so", "libtorchaudio_sox.so"}
    files = {path.name: path for path in root.glob("*.so") if path.is_file() and not path.is_symlink()}
    if set(files) != expected or any(not is_elf(path) for path in files.values()):
        raise ValueError("torchaudio native ELF set differs from the exact core/optional-SoX inventory")
    active = sorted((files["_torchaudio.so"], files["libtorchaudio.so"]))
    optional_sox = sorted((files["_torchaudio_sox.so"], files["libtorchaudio_sox.so"]))
    return active, optional_sox


# The deadline covers the entire active ELF set; each child process gets only the remaining budget.
def preflight_elf_dependencies(elf_files: list[Path], env: dict[str, str], *, timeout_seconds: float = 60.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    seen: set[Path] = set()
    for binary in elf_files:
        resolved = binary.resolve(strict=True)
        if resolved in seen:
            continue
        seen.add(resolved)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"aggregate ELF dependency preflight exceeded its {timeout_seconds:.1f}s deadline")
        output = run(["/usr/bin/ldd", str(binary)], env=env, timeout=remaining)
        missing = [line.strip() for line in output.splitlines() if "not found" in line]
        if missing:
            raise ValueError(f"unresolved ELF dependency in source input {binary}: {'; '.join(missing)}")
    if time.monotonic() >= deadline:
        raise TimeoutError(f"aggregate ELF dependency preflight exceeded its {timeout_seconds:.1f}s deadline")


def inventory_tree_symlinks(root: Path, *, allowed_external: dict[str, dict[str, object]] | None = None) -> list[dict[str, object]]:
    source_root = root.resolve(strict=True)
    allowed_external = allowed_external or {}
    records: list[dict[str, object]] = []
    seen_external: set[str] = set()
    for path in sorted(source_root.rglob("*")):
        if not path.is_symlink():
            continue
        relative = path.relative_to(source_root).as_posix()
        target = path.readlink().as_posix()
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise ValueError(f"directory or non-file symlink in runtime input: {path}")
        if resolved.is_relative_to(source_root):
            records.append({
                "path": relative,
                "target": target,
                "resolvedPath": resolved.relative_to(source_root).as_posix(),
                "bytes": resolved.stat().st_size,
                "sha256": sha256(resolved),
                "disposition": "materialize",
            })
            continue
        expected = allowed_external.get(relative)
        if expected is None:
            raise ValueError(f"escaping symlink in runtime input: {relative} -> {target}")
        actual = {
            "target": target,
            "resolvedPath": str(resolved),
            "bytes": resolved.stat().st_size,
            "sha256": sha256(resolved),
        }
        if any(actual[key] != expected[key] for key in actual):
            raise ValueError(f"external runtime symlink differs from its exact pinned metadata: {relative}")
        records.append({"path": relative, **actual, "disposition": "omit", "reason": expected["reason"]})
        seen_external.add(relative)
    if seen_external != set(allowed_external):
        raise ValueError(f"expected exact external runtime symlink set differs: missing={sorted(set(allowed_external) - seen_external)}")
    return records


def inventory_single_file_symlink(path: Path, *, expected_target: str | None = None) -> dict[str, object] | None:
    if not path.is_symlink():
        if not path.is_file():
            raise ValueError(f"runtime input is not a regular file: {path}")
        return None
    target = path.readlink().as_posix()
    if expected_target is None or target != expected_target:
        raise ValueError(f"unexpected symlink for a single-file runtime input: {path} -> {target}")
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"single-file runtime symlink target is not regular: {path}")
    return {
        "path": str(path),
        "target": target,
        "resolvedPath": str(resolved),
        "bytes": resolved.stat().st_size,
        "sha256": sha256(resolved),
        "disposition": "materialize",
    }


def copy_tree(source: Path, destination: Path, rows: list[dict[str, object]], *, omit: set[str] = frozenset(), omit_exact: set[str] = frozenset()) -> list[dict[str, object]]:
    root = source.resolve(strict=True)
    omitted: list[dict[str, object]] = []
    for item in sorted(root.rglob("*")):
        relative = item.relative_to(root)
        if relative.as_posix() in omit_exact:
            resolved = item.resolve(strict=True) if item.is_symlink() else item
            if not resolved.is_file():
                raise ValueError(f"expected omitted vendor asset is not a regular file: {item}")
            omitted_row = {"path": relative.as_posix(), "bytes": resolved.stat().st_size, "sha256": sha256(resolved)}
            if item.is_symlink():
                omitted_row["target"] = item.readlink().as_posix()
                omitted_row["resolvedPath"] = str(resolved)
            omitted.append(omitted_row)
            continue
        if any(part in omit or ("pip*" in omit and part.startswith("pip-")) for part in relative.parts):
            continue
        if item.suffix in {".pyc", ".pyo"} or "__pycache__" in relative.parts:
            continue
        if item.is_symlink():
            resolved = item.resolve(strict=True)
            if not resolved.is_relative_to(root) or not resolved.is_file():
                raise ValueError(f"escaping or directory symlink in runtime input: {item}")
            add_file(resolved, destination / relative, rows)
        elif item.is_file():
            add_file(item, destination / relative, rows)
    return omitted


def preflight_omitted_vendor_assets(site_source: Path) -> list[dict[str, object]]:
    root = site_source.resolve(strict=True)
    expected_scipy = {
        path.removeprefix("scipy/io/tests/data/")
        for path in OMITTED_VENDOR_ASSETS
        if path.startswith("scipy/io/tests/data/")
    }
    actual_scipy = {path.name for path in (root / "scipy/io/tests/data").glob("*.wav")}
    if actual_scipy != expected_scipy:
        raise ValueError("SciPy test audio paths differ from the exact exclusion inventory")
    records: list[dict[str, object]] = []
    for relative in sorted(OMITTED_VENDOR_ASSETS):
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"declared omitted Python vendor asset is absent or not regular: {relative}")
        records.append({
            "path": f"{SITE_PACKAGES}/{relative}",
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    if len({row["path"] for row in records}) != len(OMITTED_VENDOR_ASSETS):
        raise ValueError("omitted vendor asset inventory contains duplicate paths")
    return records


def verify_omitted_vendor_copy(preflight: list[dict[str, object]], copied: list[dict[str, object]]) -> list[dict[str, object]]:
    copied_by_relative_path = {row["path"]: row for row in copied}
    if len(copied_by_relative_path) != len(copied):
        raise ValueError("copy traversal recorded duplicate omitted vendor paths")
    normalized = {
        f"{SITE_PACKAGES}/{relative}": row
        for relative, row in copied_by_relative_path.items()
    }
    if set(normalized) != {row["path"] for row in preflight}:
        raise ValueError("copy traversal omitted asset paths differ from the preflight inventory")
    for expected in preflight:
        copied_row = normalized[expected["path"]]
        if copied_row["bytes"] != expected["bytes"] or copied_row["sha256"] != expected["sha256"]:
            raise ValueError(f"omitted vendor asset changed after preflight: {expected['path']}")
    return preflight


def verify_omitted_symlink_copy(preflight: list[dict[str, object]], copied: list[dict[str, object]]) -> None:
    copied_by_path = {row["path"]: row for row in copied}
    expected = [row for row in preflight if row["disposition"] == "omit"]
    if len(copied_by_path) != len(copied) or set(copied_by_path) != {row["path"] for row in expected}:
        raise ValueError("copied Python base symlink omissions differ from preflight")
    for row in expected:
        copied_row = copied_by_path[row["path"]]
        if any(copied_row.get(key) != row.get(key) for key in ("target", "resolvedPath", "bytes", "sha256")):
            raise ValueError(f"Python base symlink changed between preflight and copy: {row['path']}")


def inventory_node_symlinks(product_root: Path, packages: list[str]) -> list[dict[str, object]]:
    dependency_root = Path("/srv/projects/brai/node_modules").resolve(strict=True)
    records: list[dict[str, object]] = []
    for locator in packages:
        package_path = product_root / locator
        resolved_root = package_path.resolve(strict=True)
        if package_path.is_symlink():
            if not resolved_root.is_relative_to(dependency_root) or not resolved_root.is_dir():
                raise ValueError(f"production dependency package symlink escapes the prepared dependency store: {locator}")
            records.append({
                "path": locator,
                "target": package_path.readlink().as_posix(),
                "resolvedPath": str(resolved_root),
                "disposition": "materialize-package-tree",
            })
        records.extend({"package": locator, **row} for row in inventory_tree_symlinks(resolved_root))
    return records


def preflight_llama_tree(llama_root: Path, manifest_file: Path, manifest: dict[str, object]) -> tuple[set[Path], list[dict[str, object]]]:
    if manifest_file.is_symlink() or manifest_file != llama_root / "runtime-manifest.json":
        raise ValueError("llama provenance manifest must be the exact file inside the accepted root")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("llama manifest has no pinned file inventory")
    accepted: set[Path] = set()
    for entry in entries:
        source = Path(entry["path"])
        if not source.is_absolute() or source.is_symlink() or not source.resolve(strict=True).is_relative_to(llama_root):
            raise ValueError("llama manifest source escaped its accepted regular-file extraction root")
        if not source.is_file() or sha256(source) != entry["sha256"]:
            raise ValueError("llama manifest file SHA-256 mismatch")
        accepted.add(source.resolve(strict=True))
    regular = {path.resolve() for path in llama_root.rglob("*") if path.is_file() and not path.is_symlink()}
    if regular != accepted | {manifest_file}:
        raise ValueError("llama extraction contains unmanifested or missing regular files")
    symlinks = inventory_tree_symlinks(llama_root)
    for record in symlinks:
        target = (llama_root / record["path"]).resolve(strict=True)
        if target not in accepted:
            raise ValueError(f"llama alias target is absent from the pinned manifest: {record['path']}")
        record["disposition"] = "materialize-manifest-alias"
    return accepted, symlinks


def ldd_closure(
    elf_files: list[Path],
    runtime_root: Path,
    destination: Path,
    rows: list[dict[str, object]],
    env: dict[str, str],
    loader_search_dirs: set[str],
) -> None:
    seen: dict[str, str] = {}
    hashes: dict[Path, tuple[tuple[int, int, int, int, int], str]] = {}
    searchable: dict[tuple[str, str], bool] = {}

    def dependency_hash(path: Path) -> str:
        """Повторно использовать digest только при неизменной идентичности файла в этом вызове."""
        before = path.stat()
        identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        cached = hashes.get(path)
        if cached is not None and cached[0] == identity:
            return cached[1]
        digest = sha256(path)
        after = path.stat()
        if identity != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("ELF dependency changed while calculating its SHA-256")
        hashes[path] = (identity, digest)
        return digest

    for binary in elf_files:
        output = run(["/usr/bin/ldd", str(binary)], env=env)
        for line in output.splitlines():
            if "not found" in line:
                raise ValueError(f"unresolved ELF dependency in {binary}: {line.strip()}")
            match = re.search(r"\s(\S+)\s+=>\s+(/\S+)", line)
            if not match:
                continue
            soname, resolved_name = match.groups()
            resolved = Path(resolved_name).resolve(strict=True)
            if soname in SYSTEM_BASE_NEEDED:
                continue
            content_hash = dependency_hash(resolved)
            key = (soname, content_hash)
            if key not in searchable:
                searchable[key] = any(
                    Path(str(row["destination"])).name == soname
                    and str(row["sha256"]) == content_hash
                    and Path(str(row["destination"])).parent.relative_to(runtime_root).as_posix() in loader_search_dirs
                    for row in rows
                )
            if searchable[key]:
                continue
            if soname in seen:
                if seen[soname] != content_hash:
                    raise ValueError(f"conflicting ELF dependency bytes for SONAME {soname}")
                continue
            seen[soname] = content_hash
            add_file(resolved, destination / soname, rows, mode=0o644)


def node_production_closure(product_root: Path, package_lock_path: Path) -> list[str]:
    lock = json.loads(package_lock_path.read_text(encoding="utf-8"))
    packages = lock.get("packages")
    service = packages.get("services/local-ai") if isinstance(packages, dict) else None
    if not isinstance(service, dict) or service.get("dependencies") != {"ajv": "8.17.1", "nats": "2.29.3", "pg": "8.16.3"}:
        raise ValueError("product lock lacks the exact local-ai runtime dependency declaration")

    def resolve(parent: str, name: str) -> str:
        parent_path = Path(parent) if parent else Path()
        while True:
            candidate = (parent_path / "node_modules" / name).as_posix().lstrip("./")
            if candidate in packages:
                return candidate
            if not parent_path.parts:
                break
            parent_path = parent_path.parent
        raise ValueError(f"locked Node dependency cannot be resolved: {parent}: {name}")

    included: set[str] = set()
    pending = [("", name, False) for name in service["dependencies"]]
    while pending:
        parent, name, optional = pending.pop()
        try:
            locator = resolve(parent, name)
        except ValueError:
            if optional:
                continue
            raise
        package_dir = product_root / locator
        if optional and not package_dir.is_dir():
            continue
        if locator in included:
            continue
        record = packages[locator]
        if record.get("dev") or record.get("devOptional"):
            if optional:
                continue
            raise ValueError(f"production dependency resolves to a dev-only package: {locator}")
        included.add(locator)
        for dependency in record.get("dependencies", {}):
            pending.append((locator, dependency, False))
        for dependency in record.get("optionalDependencies", {}):
            pending.append((locator, dependency, True))
        optional_peers = record.get("peerDependenciesMeta", {})
        for dependency in record.get("peerDependencies", {}):
            pending.append((locator, dependency, optional_peers.get(dependency, {}).get("optional", False)))
    node_modules = product_root / "node_modules"
    if not node_modules.is_dir() or node_modules.is_symlink():
        raise ValueError("prepared worktree production node_modules is missing")
    for locator in included:
        relative = Path(locator).relative_to("node_modules")
        package_dir = node_modules / relative
        resolved = package_dir.resolve(strict=True)
        dependency_root = Path("/srv/projects/brai/node_modules").resolve(strict=True)
        if not package_dir.is_dir() or (package_dir.is_symlink() and not resolved.is_relative_to(dependency_root)):
            raise ValueError(f"prepared Node package missing or symlinked: {locator}")
        package_json = json.loads((resolved / "package.json").read_text(encoding="utf-8"))
        if package_json.get("version") != packages[locator].get("version"):
            raise ValueError(f"prepared Node package version differs from lock: {locator}")
    return sorted(included)


def parse_lock(path: Path) -> dict[str, str]:
    if sha256(path) != LOCK_SHA:
        raise ValueError("Python requirements lock SHA-256 mismatch")
    locked: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or line.startswith("--"):
            continue
        requirement = line.split("\\", 1)[0].strip()
        match = re.match(r"([A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_,.-]+\])?==([^ ;]+)", requirement)
        if match:
            locked[re.sub(r"[-_.]+", "-", match.group(1)).lower()] = match.group(2)
    return locked


def verify_python_closure(python: Path, lock: Path) -> dict[str, str]:
    locked = parse_lock(lock)
    output = run([str(python), "-c", "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name'].lower():d.version for d in m.distributions()}))"])
    installed = json.loads(output)
    normalized = {re.sub(r"[-_.]+", "-", name).lower(): version for name, version in installed.items()}
    normalized.pop("pip", None)
    if normalized != locked:
        raise ValueError("installed Python distribution set differs from the full hashed lock")
    return dict(sorted(normalized.items()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--node-root", required=True, type=Path)
    parser.add_argument("--python-base", required=True, type=Path, help="Ubuntu 24.04 CPython 3.12 prefix")
    parser.add_argument("--gigaam-venv", required=True, type=Path)
    parser.add_argument("--requirements-lock", required=True, type=Path)
    parser.add_argument("--product-root", required=True, type=Path)
    parser.add_argument("--package-lock", required=True, type=Path)
    parser.add_argument("--llama-root", required=True, type=Path)
    parser.add_argument("--llama-manifest", required=True, type=Path)
    parser.add_argument("--ffmpeg", default=Path("/usr/bin/ffmpeg"), type=Path)
    parser.add_argument("--ffprobe", default=Path("/usr/bin/ffprobe"), type=Path)
    parser.add_argument("--ffmpeg-package-version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if len(args.source_revision) != 40 or any(c not in "0123456789abcdef" for c in args.source_revision):
        raise ValueError("source revision must be a full lowercase Git object id")
    if args.ffmpeg_package_version != "7:6.1.1-3ubuntu5":
        raise ValueError("FFmpeg package version is not the accepted Ubuntu 24.04 build")
    out = args.output.absolute()
    if out.exists() or out.is_symlink():
        raise ValueError("portable runtime output must not exist")
    python_base = args.python_base.resolve(strict=True)
    venv = args.gigaam_venv.resolve(strict=True)
    node_root = args.node_root.resolve(strict=True)
    llama_root = args.llama_root.resolve(strict=True)
    product_root = args.product_root.resolve(strict=True)
    if python_base != Path("/usr") or node_root != Path("/opt/node-v24.21.0-linux-x64"):
        raise ValueError("Python and Node roots differ from the accepted prepared runtimes")
    if venv != Path("/opt/brai/local-ai/runtime/gigaam_pytorch/.venv"):
        raise ValueError("GigaAM venv path differs from the accepted CPU runtime")
    if args.requirements_lock.resolve(strict=True) != product_root / "services/local-ai/runners/gigaam/requirements.lock":
        raise ValueError("Python lock must come from the exact product checkout")
    if args.package_lock.resolve(strict=True) != product_root / "package-lock.json":
        raise ValueError("Node lock must come from the exact product checkout")
    if args.ffmpeg.resolve(strict=True) != Path("/usr/bin/ffmpeg") or args.ffprobe.resolve(strict=True) != Path("/usr/bin/ffprobe"):
        raise ValueError("FFmpeg tools must come from the accepted Ubuntu package paths")
    if run(["/usr/bin/git", "-C", str(product_root), "rev-parse", "HEAD"]).strip() != args.source_revision:
        raise ValueError("product checkout HEAD does not match the explicit source revision")
    if run(["/usr/bin/git", "-C", str(product_root), "status", "--porcelain", "--untracked-files=all"]):
        raise ValueError("product checkout is dirty; refusing to bind input inventory to a committed revision")
    if run([str(node_root / "bin/node"), "--version"]).strip() != "v24.21.0":
        raise ValueError("Node input version mismatch")
    python_binary = python_base / "bin/python3.12"
    if not python_binary.exists():
        python_binary = Path("/usr/bin/python3.12")
    single_file_symlinks: list[dict[str, object]] = []
    for input_file in (node_root / "bin/node", python_binary, args.ffmpeg, args.ffprobe):
        record = inventory_single_file_symlink(input_file)
        if record:
            single_file_symlinks.append(record)
    if run([str(python_binary), "--version"]).strip() != "Python 3.12.3":
        raise ValueError("CPython base interpreter is not the accepted 3.12.3 build")
    llama_manifest = json.loads(args.llama_manifest.read_text(encoding="utf-8"))
    if llama_manifest.get("image") != LLAMA_IMAGE:
        raise ValueError("llama runtime manifest image digest mismatch")
    python_distributions = verify_python_closure(venv / "bin/python", args.requirements_lock)
    if "2.39" not in run(["/usr/bin/ldd", "--version"]).splitlines()[0]:
        raise ValueError("source host does not expose the required glibc 2.39 ABI")
    site_source = venv / "lib/python3.12/site-packages"
    for relative, (expected_size, expected_sha) in VENDOR_DATA.items():
        vendor_file = site_source / Path(relative).relative_to(SITE_PACKAGES)
        if not vendor_file.is_file() or vendor_file.is_symlink() or vendor_file.stat().st_size != expected_size or sha256(vendor_file) != expected_sha:
            raise ValueError(f"allowlisted Python vendor data does not match its exact hash/size pin: {relative}")
    omitted_preflight = preflight_omitted_vendor_assets(site_source)
    active_torchcodec_preflight, inactive_torchcodec_preflight = select_torchcodec_elfs(site_source / "torchcodec")
    active_torio_preflight, inactive_torio_preflight = select_torio_elfs(site_source / "torio/lib")
    active_torchaudio_preflight, optional_sox_preflight = inventory_torchaudio_elfs(site_source / "torchaudio/lib")
    optional_sox_inventory = [{
        "path": f"{SITE_PACKAGES}/{path.relative_to(site_source).as_posix()}",
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "reason": "lazy optional SoX backend; product audio path uses FFmpeg/TorchCodec and torchaudio functional transforms",
        "requiredLibrary": "libsox.so",
    } for path in optional_sox_preflight]
    vendor_data = [{"path": path, "bytes": size, "sha256": digest} for path, (size, digest) in sorted(VENDOR_DATA.items())]
    python_base_lib = python_base / "lib/python3.12"
    python_base_symlinks = inventory_tree_symlinks(
        python_base_lib,
        allowed_external=PYTHON_BASE_OMITTED_LINKS,
    )
    site_package_symlinks = inventory_tree_symlinks(site_source)
    libpython_sources = sorted(Path("/usr/lib/x86_64-linux-gnu").glob("libpython3.12.so*"))
    if {path.name for path in libpython_sources} != {"libpython3.12.so.1", "libpython3.12.so.1.0"}:
        raise ValueError("libpython runtime ABI file set differs from the accepted Ubuntu 24.04 closure")
    for library in libpython_sources:
        if library.is_symlink():
            record = inventory_single_file_symlink(library, expected_target=LIBPYTHON_SONAME_LINK["target"])
            if not record or any(record[key] != LIBPYTHON_SONAME_LINK[key] for key in ("resolvedPath", "bytes", "sha256")):
                raise ValueError("libpython SONAME symlink differs from the exact pinned Ubuntu ABI file")
            single_file_symlinks.append(record)
        elif not library.is_file():
            raise ValueError(f"libpython ABI input is not a regular file: {library}")
    node_packages = node_production_closure(product_root, args.package_lock)
    node_symlinks = inventory_node_symlinks(product_root, node_packages)
    llama_manifest_file = args.llama_manifest.resolve(strict=True)
    accepted_llama_files, llama_symlinks = preflight_llama_tree(llama_root, llama_manifest_file, llama_manifest)
    llama_manifest_sha = sha256(llama_manifest_file)
    llama_files = llama_manifest["files"]
    torchcodec_source_root = site_source / "torchcodec"
    torio_source_root = site_source / "torio/lib"
    torchaudio_source_root = site_source / "torchaudio/lib"
    source_elf_files: list[Path] = [node_root / "bin/node", python_binary, args.ffmpeg, args.ffprobe]
    for package in node_packages:
        package_root = (product_root / package).resolve(strict=True)
        source_elf_files.extend(path for path in package_root.rglob("*") if path.is_file() and is_elf(path))
    for path in python_base_lib.rglob("*"):
        relative = path.relative_to(python_base_lib)
        if any(part in {"__pycache__", "test", "tests"} for part in relative.parts):
            continue
        if path.is_symlink() and relative.as_posix() in PYTHON_BASE_OMITTED_LINKS:
            continue
        if path.is_file() and is_elf(path):
            source_elf_files.append(path)
    for path in site_source.rglob("*"):
        if not path.is_file() or not is_elf(path):
            continue
        relative = path.relative_to(site_source)
        if any(part == "pip" or part.startswith("pip-") or part in {"__pycache__", ".pytest_cache"} for part in relative.parts):
            continue
        if path.is_relative_to(torchcodec_source_root) or path.is_relative_to(torio_source_root) or path.is_relative_to(torchaudio_source_root):
            continue
        source_elf_files.append(path)
    source_elf_files.extend(active_torchcodec_preflight)
    source_elf_files.extend(active_torio_preflight)
    source_elf_files.extend(active_torchaudio_preflight)
    source_elf_files.extend(path.resolve(strict=True) for path in libpython_sources if path.is_file())
    source_elf_files.extend(accepted_llama_files)
    source_ldd_env = {
        "PATH": "/usr/bin:/bin",
        "LD_LIBRARY_PATH": ":".join((
            str(llama_root / "app"),
            str(llama_root / "system"),
            str(site_source / "torch/lib"),
            str(torchcodec_source_root),
            str(torio_source_root),
            str(torchaudio_source_root),
            "/usr/lib/x86_64-linux-gnu",
            "/lib/x86_64-linux-gnu",
        )),
        "LANG": "C",
        "LC_ALL": "C",
    }
    preflight_elf_dependencies(source_elf_files, source_ldd_env)

    output_parent = out.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out.name}.", dir=output_parent))
    rows: list[dict[str, object]] = []
    try:
        runtime = staging / "runtime"
        node_dest = runtime / "node-v24.21.0-linux-x64/bin/node"
        add_file(node_root / "bin/node", node_dest, rows, mode=0o755)
        for locator in node_packages:
            relative = Path(locator).relative_to("node_modules")
            copy_tree(
                product_root / locator,
                runtime / "app/services/local-ai/node_modules" / relative,
                rows,
                omit={"node_modules"},
            )

        py_dest = runtime / "gigaam_pytorch/.venv"
        py_dest.mkdir(parents=True)
        add_file(python_binary, runtime / "python/bin/python3.12", rows, mode=0o755)
        add_file(python_binary, py_dest / "bin/python", rows, mode=0o755)
        (py_dest / "pyvenv.cfg").write_text("home = /opt/brai/local-ai/runtime/python/bin\ninclude-system-site-packages = false\nversion = 3.12.3\n", encoding="utf-8")
        (py_dest / "pyvenv.cfg").chmod(0o444)
        rows.append({"source": "generated:pyvenv.cfg", "destination": (py_dest / "pyvenv.cfg").as_posix(), "bytes": (py_dest / "pyvenv.cfg").stat().st_size, "sha256": sha256(py_dest / "pyvenv.cfg"), "mode": "0444"})
        omitted_copy = copy_tree(
            site_source,
            py_dest / "lib/python3.12/site-packages",
            rows,
            omit={"__pycache__", ".pytest_cache", "pip", "pip*"},
            omit_exact=set(OMITTED_VENDOR_ASSETS),
        )
        omitted = verify_omitted_vendor_copy(omitted_preflight, omitted_copy)

        python_lib = runtime / "python/lib/python3.12"
        python_base_omitted = copy_tree(
            python_base_lib,
            python_lib,
            rows,
            omit={"__pycache__", "test", "tests"},
            omit_exact=set(PYTHON_BASE_OMITTED_LINKS),
        )
        verify_omitted_symlink_copy(python_base_symlinks, python_base_omitted)
        for library in libpython_sources:
            if library.is_symlink():
                add_file(library.resolve(strict=True), runtime / "python/lib" / library.name, rows)
            elif library.is_file():
                add_file(library, runtime / "python/lib" / library.name, rows)

        for item in llama_files:
            source_file = Path(item["path"])
            if not source_file.is_absolute() or not source_file.resolve(strict=True).is_relative_to(llama_root):
                raise ValueError("llama manifest source escaped its accepted extraction root")
            if sha256(source_file) != item["sha256"]:
                raise ValueError("llama manifest file SHA-256 mismatch")
            relative = source_file.relative_to(llama_root)
            target = runtime / "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571" / relative
            add_file(source_file, target, rows)
        for alias in llama_root.rglob("*"):
            if not alias.is_symlink():
                continue
            resolved = alias.resolve(strict=True)
            if resolved not in accepted_llama_files:
                raise ValueError(f"llama alias target is absent from the pinned manifest: {alias}")
            relative = alias.relative_to(llama_root)
            target = runtime / "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571" / relative
            add_file(resolved, target, rows)
        if not accepted_llama_files:
            raise ValueError("pinned llama extraction has no accepted binary files")

        for source, name in ((args.ffmpeg, "ffmpeg"), (args.ffprobe, "ffprobe")):
            add_file(source.resolve(strict=True), runtime / "ffmpeg/bin" / name, rows, mode=0o755)
        elf_sources: list[Path] = [node_dest, py_dest / "bin/python", args.ffmpeg.resolve(strict=True), args.ffprobe.resolve(strict=True)]
        torchcodec_root = py_dest / "lib/python3.12/site-packages/torchcodec"
        active_torchcodec, inactive_torchcodec = select_torchcodec_elfs(torchcodec_root)
        if [path.name for path in active_torchcodec] != [path.name for path in active_torchcodec_preflight] or [path.name for path in inactive_torchcodec] != [path.name for path in inactive_torchcodec_preflight]:
            raise ValueError("TorchCodec ABI files changed between preflight and copy")
        torio_root = py_dest / "lib/python3.12/site-packages/torio/lib"
        active_torio, inactive_torio = select_torio_elfs(torio_root)
        if [path.name for path in active_torio] != [path.name for path in active_torio_preflight] or [path.name for path in inactive_torio] != [path.name for path in inactive_torio_preflight]:
            raise ValueError("torio FFmpeg ABI files changed between preflight and copy")
        torchaudio_root = py_dest / "lib/python3.12/site-packages/torchaudio/lib"
        active_torchaudio, optional_sox = inventory_torchaudio_elfs(torchaudio_root)
        if [path.name for path in active_torchaudio] != [path.name for path in active_torchaudio_preflight] or [path.name for path in optional_sox] != [path.name for path in optional_sox_preflight]:
            raise ValueError("torchaudio core/optional-SoX ABI files changed between preflight and copy")
        for path, expected in zip(optional_sox, optional_sox_inventory, strict=True):
            if path.name != Path(expected["path"]).name or sha256(path) != expected["sha256"] or path.stat().st_size != expected["bytes"]:
                raise ValueError("optional torchaudio SoX file changed between preflight and copy")
        elf_sources.extend(
            path for path in (py_dest / "lib/python3.12/site-packages").rglob("*")
            if path.is_file() and is_elf(path) and not path.is_relative_to(torchcodec_root) and not path.is_relative_to(torio_root) and not path.is_relative_to(torchaudio_root)
        )
        elf_sources.extend(active_torchcodec)
        elf_sources.extend(active_torio)
        elf_sources.extend(active_torchaudio)
        for elf_root in (python_lib, runtime / "llama_cpp"):
            elf_sources.extend(path for path in elf_root.rglob("*") if path.is_file() and is_elf(path))
        ldd_env = {
            "PATH": "/usr/bin:/bin",
            "LD_LIBRARY_PATH": ":".join((
                str(llama_root / "app"),
                str(llama_root / "system"),
                str(py_dest / "lib/python3.12/site-packages/torch/lib"),
                str(torchcodec_root),
                str(torio_root),
                str(torchaudio_root),
            )),
            "LANG": "C",
            "LC_ALL": "C",
        }
        loader_search_dirs = {
            "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/app",
            "llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/system",
            "python/lib",
            "python/lib/python3.12/lib-dynload",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/torch/lib",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/torchcodec",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/torio/lib",
            "gigaam_pytorch/.venv/lib/python3.12/site-packages/torchaudio/lib",
            "system-libs",
        }
        ldd_closure(elf_sources, runtime, runtime / "system-libs", rows, ldd_env, loader_search_dirs)

        inventory = {
            "formatVersion": 1,
            "sourceRevision": args.source_revision,
            "pythonLockSha256": LOCK_SHA,
            "pythonDistributions": python_distributions,
            "nodePackageLockSha256": sha256(args.package_lock),
            "nodeProductionPackages": node_packages,
            "llamaImage": LLAMA_IMAGE,
            "llamaManifestSha256": llama_manifest_sha,
            "baseImage": BASE_REF,
            "glibcAbi": "Ubuntu 24.04 / glibc 2.39",
            "ffmpegPackageVersion": args.ffmpeg_package_version,
            "vendorData": vendor_data,
            "omittedVendorAssets": omitted,
            "torchcodecAbiSelection": {
                "activeFfmpegMajor": 6,
                "activeFiles": [{"path": str(path.relative_to(runtime)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in active_torchcodec],
                "inactiveFallbackFiles": [{"path": str(path.relative_to(runtime)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in inactive_torchcodec],
            },
            "torioAbiSelection": {
                "activeFfmpegMajor": 6,
                "activeFiles": [{"path": str(path.relative_to(runtime)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in active_torio],
                "inactiveFallbackFiles": [{"path": str(path.relative_to(runtime)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in inactive_torio],
            },
            "torchaudioAbiSelection": {
                "activeFiles": [{"path": str(path.relative_to(runtime)), "sha256": sha256(path), "bytes": path.stat().st_size} for path in active_torchaudio],
                "optionalSoxBackend": {"active": False, "requiredLibrary": "libsox.so", "files": optional_sox_inventory},
            },
            "cachePythonExecutable": "gigaam_pytorch/.venv/bin/python",
            "cachePythonExecutableHost": str(venv / "bin/python"),
            "cachePythonExecutableHostSha256": sha256(venv / "bin/python"),
            "files": [
                {
                    "source": Path(str(row["destination"])).relative_to(runtime).as_posix(),
                    "destination": (
                        Path(str(row["destination"])).relative_to(runtime).as_posix()
                        if Path(str(row["destination"])).relative_to(runtime).as_posix().startswith("app/")
                        else "runtime/" + Path(str(row["destination"])).relative_to(runtime).as_posix()
                    ),
                    "bytes": row["bytes"], "sha256": row["sha256"], "mode": row["mode"],
                }
                for row in rows
            ],
            "provenance": [{
                "source": row["source"],
                "destination": Path(str(row["destination"])).relative_to(runtime).as_posix(),
                "bytes": row["bytes"], "sha256": row["sha256"], "mode": row["mode"],
            } for row in rows],
            "symlinkInventory": {
                "pythonBase": python_base_symlinks,
                "pythonSitePackages": site_package_symlinks,
                "nodePackages": node_symlinks,
                "llamaExtraction": llama_symlinks,
                "singleFileInputs": single_file_symlinks,
            },
            "omittedPythonBaseSymlinks": [row for row in python_base_symlinks if row["disposition"] == "omit"],
        }
        (staging / "runtime-manifest.json").write_text(json.dumps(inventory, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        os.replace(runtime, out)
        os.replace(staging / "runtime-manifest.json", out.parent / f"{out.name}-manifest.json")
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(f"portable runtime inventory prepared: {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"portable runtime rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
