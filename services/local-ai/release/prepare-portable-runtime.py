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


def copy_tree(source: Path, destination: Path, rows: list[dict[str, object]], *, omit: set[str] = frozenset(), omit_exact: set[str] = frozenset()) -> list[dict[str, object]]:
    root = source.resolve(strict=True)
    omitted: list[dict[str, object]] = []
    for item in sorted(root.rglob("*")):
        relative = item.relative_to(root)
        if relative.as_posix() in omit_exact:
            if item.is_symlink() or not item.is_file():
                raise ValueError(f"expected omitted vendor asset is not a regular file: {item}")
            omitted.append({"path": relative.as_posix(), "bytes": item.stat().st_size, "sha256": sha256(item)})
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


def ldd_closure(
    elf_files: list[Path],
    runtime_root: Path,
    destination: Path,
    rows: list[dict[str, object]],
    env: dict[str, str],
    loader_search_dirs: set[str],
) -> None:
    seen: dict[str, str] = {}
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
            content_hash = sha256(resolved)
            already_searchable = any(
                Path(str(row["destination"])).name == soname
                and str(row["sha256"]) == content_hash
                and Path(str(row["destination"])).parent.relative_to(runtime_root).as_posix() in loader_search_dirs
                for row in rows
            )
            if already_searchable:
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
        match = re.match(r"([A-Za-z0-9_.-]+)==([^ ;]+)", requirement)
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
    if run([str(python_binary), "--version"]).strip() != "Python 3.12.3":
        raise ValueError("CPython base interpreter is not the accepted 3.12.3 build")
    llama_manifest = json.loads(args.llama_manifest.read_text(encoding="utf-8"))
    if llama_manifest.get("image") != LLAMA_IMAGE:
        raise ValueError("llama runtime manifest image digest mismatch")
    python_distributions = verify_python_closure(venv / "bin/python", args.requirements_lock)
    if "2.39" not in run(["/usr/bin/ldd", "--version"]).splitlines()[0]:
        raise ValueError("source host does not expose the required glibc 2.39 ABI")

    output_parent = out.parent
    output_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out.name}.", dir=output_parent))
    rows: list[dict[str, object]] = []
    try:
        runtime = staging / "runtime"
        node_dest = runtime / "node-v24.21.0-linux-x64/bin/node"
        add_file(node_root / "bin/node", node_dest, rows, mode=0o755)
        node_packages = node_production_closure(product_root, args.package_lock)
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
        site_source = venv / "lib/python3.12/site-packages"
        for relative, (expected_size, expected_sha) in VENDOR_DATA.items():
            vendor_file = site_source / Path(relative).relative_to(SITE_PACKAGES)
            if not vendor_file.is_file() or vendor_file.is_symlink() or vendor_file.stat().st_size != expected_size or sha256(vendor_file) != expected_sha:
                raise ValueError(f"allowlisted Python vendor data does not match its exact hash/size pin: {relative}")
        omitted_expected = {key.removeprefix("scipy/io/tests/data/") for key in OMITTED_VENDOR_ASSETS if key.startswith("scipy/io/tests/data/")}
        scipy_wavs = {path.name for path in (site_source / "scipy/io/tests/data").glob("*.wav")}
        if scipy_wavs != omitted_expected:
            raise ValueError("SciPy test audio set differs from the exact excluded input list")
        omitted = copy_tree(
            site_source,
            py_dest / "lib/python3.12/site-packages",
            rows,
            omit={"__pycache__", ".pytest_cache", "pip", "pip*"},
            omit_exact=set(OMITTED_VENDOR_ASSETS),
        )
        if {f"{SITE_PACKAGES}/{row['path']}" for row in omitted} != set(OMITTED_VENDOR_ASSETS):
            raise ValueError("an explicitly excluded Python vendor asset is missing")
        vendor_data = [{"path": path, "bytes": size, "sha256": digest} for path, (size, digest) in sorted(VENDOR_DATA.items())]

        python_lib = runtime / "python/lib/python3.12"
        copy_tree(python_base / "lib/python3.12", python_lib, rows, omit={"__pycache__", "test", "tests"})
        libpython = sorted(Path("/usr/lib/x86_64-linux-gnu").glob("libpython3.12.so*"))
        for library in libpython:
            if library.is_symlink():
                add_file(library.resolve(strict=True), runtime / "python/lib" / library.name, rows)
            elif library.is_file():
                add_file(library, runtime / "python/lib" / library.name, rows)

        llama_manifest_file = args.llama_manifest.resolve(strict=True)
        if args.llama_manifest.is_symlink() or llama_manifest_file != llama_root / "runtime-manifest.json":
            raise ValueError("llama provenance manifest must be the exact file inside the accepted root")
        llama_manifest_sha = sha256(llama_manifest_file)
        llama_files = llama_manifest.get("files")
        if not isinstance(llama_files, list) or not llama_files:
            raise ValueError("llama manifest has no pinned file inventory")
        accepted_llama_files: set[Path] = set()
        manifest_paths: set[Path] = set()
        for item in llama_files:
            source_file = Path(item["path"])
            if not source_file.is_absolute() or not source_file.resolve(strict=True).is_relative_to(llama_root):
                raise ValueError("llama manifest source escaped its accepted extraction root")
            if sha256(source_file) != item["sha256"]:
                raise ValueError("llama manifest file SHA-256 mismatch")
            accepted_llama_files.add(source_file.resolve(strict=True))
            manifest_paths.add(source_file.resolve(strict=True))
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
        regular_llama_files = {path.resolve() for path in llama_root.rglob("*") if path.is_file() and not path.is_symlink()}
        if regular_llama_files != manifest_paths | {llama_manifest_file}:
            raise ValueError("llama extraction contains unmanifested or missing regular files")

        for source, name in ((args.ffmpeg, "ffmpeg"), (args.ffprobe, "ffprobe")):
            add_file(source.resolve(strict=True), runtime / "ffmpeg/bin" / name, rows, mode=0o755)
        elf_sources: list[Path] = [node_dest, py_dest / "bin/python", args.ffmpeg.resolve(strict=True), args.ffprobe.resolve(strict=True)]
        torchcodec_root = py_dest / "lib/python3.12/site-packages/torchcodec"
        active_torchcodec, inactive_torchcodec = select_torchcodec_elfs(torchcodec_root)
        elf_sources.extend(
            path for path in (py_dest / "lib/python3.12/site-packages").rglob("*")
            if path.is_file() and is_elf(path) and not path.is_relative_to(torchcodec_root)
        )
        elf_sources.extend(active_torchcodec)
        for elf_root in (python_lib, runtime / "llama_cpp"):
            elf_sources.extend(path for path in elf_root.rglob("*") if path.is_file() and is_elf(path))
        ldd_env = {
            "PATH": "/usr/bin:/bin",
            "LD_LIBRARY_PATH": ":".join((
                str(llama_root / "app"),
                str(llama_root / "system"),
                str(py_dest / "lib/python3.12/site-packages/torch/lib"),
                str(torchcodec_root),
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
