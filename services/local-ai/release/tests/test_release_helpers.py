#!/usr/bin/env python3
# ABOUTME: Проверяет fail-closed path, ELF closure и context inventory на временных fixtures.
# ABOUTME: Не запускает продуктовый runtime, Ansible, Docker или загрузку артефактов.

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


RELEASE = Path(__file__).resolve().parents[1]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


runtime = load("release_runtime", RELEASE / "prepare-portable-runtime.py")
context_verify = load("release_context_verify", RELEASE / "verify-image-context.py")
context_builder = load("release_context_builder", RELEASE / "prepare-image-context.py")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_context_fixture(context: Path, relative_payload: str, content: bytes) -> tuple[str, Path]:
    payload_file = context / "payload" / relative_payload
    payload_file.parent.mkdir(parents=True)
    payload_file.write_bytes(content)
    payload_row = {
        "path": relative_payload,
        "sha256": sha(payload_file),
        "bytes": payload_file.stat().st_size,
        "mode": f"{payload_file.stat().st_mode & 0o7777:04o}",
    }
    rows = [payload_row]
    vendor_paths = sorted(context_verify.VENDOR_DATA_PATHS)
    vendor_files = []
    for index, relative in enumerate(vendor_paths):
        vendor_file = context / "payload" / relative
        vendor_file.parent.mkdir(parents=True, exist_ok=True)
        vendor_file.write_bytes(f"vendor-{index}".encode())
        row = {"path": relative, "sha256": sha(vendor_file), "bytes": vendor_file.stat().st_size, "mode": f"{vendor_file.stat().st_mode & 0o7777:04o}"}
        rows.append(row)
        vendor_files.append({"path": relative, "sha256": row["sha256"], "bytes": row["bytes"]})
    sums = "".join(f"{row['sha256']}  {row['path']}\n" for row in sorted(rows, key=lambda item: item["path"]))
    (context / "payload/SHA256SUMS").write_text(sums, encoding="utf-8")
    recipes_dir = context / "services/local-ai"
    recipes_dir.mkdir(parents=True)
    recipe_contents = {
        "Dockerfile": "FROM ubuntu@sha256:fixture\nENV NODE_ENV=production \\\n    LD_LIBRARY_PATH=" + ":".join(f"/opt/brai/local-ai/runtime/{item}" for item in context_verify.NATIVE_LIBRARY_SEARCH_DIRECTORIES) + "\n",
        "Dockerfile.dockerignore": "!payload/\n",
        "release.json": json.dumps({
            "source": {"revisionBuildArgument": "BRAI_SOURCE_REVISION"},
            "image": {"copyOnly": True, "baseImage": {"reference": "ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4"}},
            "runtimePayload": {"nativeLibrarySearchDirectories": context_verify.NATIVE_LIBRARY_SEARCH_DIRECTORIES},
        }),
    }
    recipe_inventory = {}
    for name, value in recipe_contents.items():
        path = recipes_dir / name
        path.write_text(value, encoding="utf-8")
        recipe_inventory[name] = {"sha256": sha(path), "bytes": path.stat().st_size, "mode": f"{path.stat().st_mode & 0o7777:04o}"}
    revision = "a" * 40
    (context / "payload-inputs.json").write_text(json.dumps({
        "sourceRevision": revision,
        "modelIncluded": False,
        "files": rows,
        "recipes": recipe_inventory,
        "allowedVendorFiles": vendor_files,
        "torchcodecAbiSelection": {"activeFfmpegMajor": 6, "activeFiles": [{"path": "active6.so"}] * 3, "inactiveFallbackFiles": [{"path": "fallback.so"}] * 9},
        "torioAbiSelection": {"activeFfmpegMajor": 6, "activeFiles": [{"path": "active6.so"}] * 2, "inactiveFallbackFiles": [{"path": "fallback.so"}] * 4},
        "torchaudioAbiSelection": {"activeFiles": [{"path": "libtorchaudio.so"}, {"path": "_torchaudio.so"}], "optionalSoxBackend": {"active": False, "requiredLibrary": "libsox.so", "files": [{"path": "libtorchaudio_sox.so", "sha256": "a" * 64, "bytes": 1}, {"path": "_torchaudio_sox.so", "sha256": "b" * 64, "bytes": 1}]}},
    }), encoding="utf-8")
    return revision, payload_file


class ReleaseHelperTests(unittest.TestCase):
    def test_runtime_manifest_paths_reject_escape_and_absolute(self) -> None:
        self.assertEqual(context_builder.safe_relative("runtime/python/bin/python3.12").as_posix(), "runtime/python/bin/python3.12")
        for value in ("../outside", "/absolute/path", "runtime/../escape"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                context_builder.safe_relative(value)

    def test_hashed_lock_parser_handles_extras_and_matches_distribution_metadata(self) -> None:
        lock = RELEASE.parent / "runners/gigaam/requirements.lock"
        locked = runtime.parse_lock(lock)
        self.assertEqual(len(locked), 98)
        self.assertEqual(locked["fsspec"], "2026.9.0")
        installed = json.dumps(locked)
        with patch.object(runtime, "run", return_value=installed):
            self.assertEqual(runtime.verify_python_closure(Path("/fixture/python"), lock), locked)

    def test_vendor_exclusion_preflight_and_copy_paths_use_same_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            site_packages = Path(temp)
            copied = []
            for relative in sorted(runtime.OMITTED_VENDOR_ASSETS):
                source = site_packages / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(relative.encode())
                copied.append({"path": relative, "bytes": source.stat().st_size, "sha256": sha(source)})
            preflight = runtime.preflight_omitted_vendor_assets(site_packages)
            self.assertEqual(len(preflight), 27)
            checked = runtime.verify_omitted_vendor_copy(preflight, copied)
            self.assertEqual({row["path"] for row in checked}, {
                f"{runtime.SITE_PACKAGES}/{path}" for path in runtime.OMITTED_VENDOR_ASSETS
            })
            with self.assertRaisesRegex(ValueError, "paths differ"):
                runtime.verify_omitted_vendor_copy(preflight, copied[:-1])

    def test_symlink_preflight_records_internal_and_exact_external_targets(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "source"
            root.mkdir()
            inside = root / "target.py"
            inside.write_bytes(b"inside target")
            (root / "alias.py").symlink_to("target.py")
            external = base / "external.so"
            external.write_bytes(b"pinned external target")
            (root / "dev-link.so").symlink_to("../external.so")
            allowed = {
                "dev-link.so": {
                    "target": "../external.so",
                    "resolvedPath": str(external),
                    "bytes": external.stat().st_size,
                    "sha256": sha(external),
                    "reason": "fixture developer-only link",
                },
            }
            records = runtime.inventory_tree_symlinks(root, allowed_external=allowed)
            self.assertEqual({row["path"] for row in records}, {"alias.py", "dev-link.so"})
            self.assertEqual(next(row for row in records if row["path"] == "alias.py")["disposition"], "materialize")
            self.assertEqual(next(row for row in records if row["path"] == "dev-link.so")["disposition"], "omit")
            with self.assertRaisesRegex(ValueError, "escaping symlink"):
                runtime.inventory_tree_symlinks(root)

    def test_copy_tree_omits_only_preflighted_external_developer_link(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "source"
            root.mkdir()
            payload = root / "runtime.py"
            payload.write_bytes(b"runtime source")
            external = base / "libpython.so.1"
            external.write_bytes(b"exact ABI bytes")
            link = root / "developer-link.so"
            link.symlink_to("../libpython.so.1")
            preflight = runtime.inventory_tree_symlinks(root, allowed_external={
                "developer-link.so": {
                    "target": "../libpython.so.1",
                    "resolvedPath": str(external),
                    "bytes": external.stat().st_size,
                    "sha256": sha(external),
                    "reason": "development alias",
                },
            })
            copied = runtime.copy_tree(root, base / "destination", [], omit_exact={"developer-link.so"})
            runtime.verify_omitted_symlink_copy(preflight, copied)
            self.assertEqual((base / "destination/runtime.py").read_bytes(), b"runtime source")
            self.assertFalse((base / "destination/developer-link.so").exists())

    def test_ldd_closure_copies_external_needed_library_by_soname(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "runner"
            library = root / "libcodec.so.1"
            binary.write_bytes(b"fixture ELF")
            library.write_bytes(b"exact shared library bytes")
            destination = root / "payload/system-libs"
            line = f"\tlibcodec.so.1 => {library} (0x00000001)"
            with patch.object(runtime, "run", return_value=line):
                rows = []
                runtime.ldd_closure([binary], root / "runtime", destination, rows, {"PATH": "/usr/bin:/bin"}, set())
            self.assertEqual((destination / "libcodec.so.1").read_bytes(), library.read_bytes())
            self.assertEqual(rows[0]["sha256"], sha(library))

    def test_ldd_closure_rejects_conflicting_soname_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first, second = root / "first", root / "second"
            lib_a, lib_b = root / "a.so", root / "b.so"
            for path, value in ((first, b"one"), (second, b"two"), (lib_a, b"A"), (lib_b, b"B")):
                path.write_bytes(value)

            def fake_run(argv, **kwargs):
                target = lib_a if argv[-1] == str(first) else lib_b
                return f"\tlibconflict.so.1 => {target} (0x1)"

            with patch.object(runtime, "run", side_effect=fake_run):
                with self.assertRaisesRegex(ValueError, "conflicting ELF"):
                    runtime.ldd_closure([first, second], root / "runtime", root / "out", [], {"PATH": "/usr/bin:/bin"}, set())

    def test_elf_preflight_uses_one_aggregate_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            first, second = Path(temp) / "first.so", Path(temp) / "second.so"
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            with patch.object(runtime.time, "monotonic", side_effect=[10.0, 10.0, 71.0]), patch.object(runtime, "run", return_value="") as mocked_run:
                with self.assertRaisesRegex(TimeoutError, "aggregate ELF dependency preflight"):
                    runtime.preflight_elf_dependencies([first, second], {"PATH": "/usr/bin:/bin"})
            self.assertEqual(mocked_run.call_count, 1)
            self.assertEqual(mocked_run.call_args.kwargs["timeout"], 60.0)

    def test_elf_preflight_shrinks_timeout_across_successful_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            binaries = [Path(temp) / f"{index}.so" for index in range(3)]
            for binary in binaries:
                binary.write_bytes(b"ELF fixture")
            with patch.object(runtime.time, "monotonic", side_effect=[10.0, 10.0, 15.0, 71.0]), patch.object(runtime, "run", return_value="") as mocked_run:
                with self.assertRaisesRegex(TimeoutError, "aggregate ELF dependency preflight"):
                    runtime.preflight_elf_dependencies(binaries, {"PATH": "/usr/bin:/bin"})
            self.assertEqual(mocked_run.call_count, 2)
            self.assertEqual([call.kwargs["timeout"] for call in mocked_run.call_args_list], [60.0, 55.0])

    def test_ldd_closure_skips_identical_library_only_in_loader_search_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / "runner"
            library = root / "libcodec.so.1"
            runtime_root = root / "runtime"
            staged = runtime_root / "torch/lib/libcodec.so.1"
            binary.write_bytes(b"fixture ELF")
            library.write_bytes(b"exact shared library bytes")
            staged.parent.mkdir(parents=True)
            staged.write_bytes(library.read_bytes())
            row = {"destination": str(staged), "sha256": sha(staged)}
            with patch.object(runtime, "run", return_value=f"\tlibcodec.so.1 => {library} (0x1)"):
                rows = [row]
                runtime.ldd_closure([binary], runtime_root, root / "system-libs", rows, {"PATH": "/usr/bin:/bin"}, {"torch/lib"})
            self.assertEqual(len(rows), 1)
            self.assertFalse((root / "system-libs/libcodec.so.1").exists())

    def test_torchcodec_selects_ffmpeg6_and_accounts_for_other_fallbacks(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for family in ("core", "custom_ops", "pybind_ops"):
                for major in (4, 5, 6, 7):
                    (root / f"libtorchcodec_{family}{major}.so").write_bytes(f"{family}-{major}".encode())
            active, inactive = runtime.select_torchcodec_elfs(root)
            self.assertEqual({path.name for path in active}, {
                "libtorchcodec_core6.so", "libtorchcodec_custom_ops6.so", "libtorchcodec_pybind_ops6.so",
            })
            self.assertEqual(len(inactive), 9)
            (root / "unexpected.so").write_bytes(b"unexpected")
            with self.assertRaisesRegex(ValueError, "TorchCodec wheel"):
                runtime.select_torchcodec_elfs(root)

    def test_torio_selects_only_exact_ffmpeg6_backends(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for prefix in ("_", "lib"):
                for major in (4, 5, 6):
                    (root / f"{prefix}torio_ffmpeg{major}.so").write_bytes(f"{prefix}-{major}".encode())
            active, inactive = runtime.select_torio_elfs(root)
            self.assertEqual({path.name for path in active}, {"_torio_ffmpeg6.so", "libtorio_ffmpeg6.so"})
            self.assertEqual({path.name for path in inactive}, {
                "_torio_ffmpeg4.so", "_torio_ffmpeg5.so", "libtorio_ffmpeg4.so", "libtorio_ffmpeg5.so",
            })
            (root / "libtorio_ffmpeg7.so").write_bytes(b"unsupported")
            with self.assertRaisesRegex(ValueError, "exact supported"):
                runtime.select_torio_elfs(root)

    def test_torchaudio_accounts_exact_optional_sox_pair(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = {"_torchaudio.so", "libtorchaudio.so", "_torchaudio_sox.so", "libtorchaudio_sox.so"}
            for name in names:
                (root / name).write_bytes(b"\x7fELF-fixture")
            active, optional = runtime.inventory_torchaudio_elfs(root)
            self.assertEqual({path.name for path in active}, {"_torchaudio.so", "libtorchaudio.so"})
            self.assertEqual({path.name for path in optional}, {"_torchaudio_sox.so", "libtorchaudio_sox.so"})
            (root / "libtorchaudio_sox7.so").write_bytes(b"unexpected")
            with self.assertRaisesRegex(ValueError, "exact core/optional-SoX"):
                runtime.inventory_torchaudio_elfs(root)

    def test_ldd_closure_resolves_active_torio_ffmpeg6_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime_root = root / "runtime"
            torio = runtime_root / "gigaam_pytorch/.venv/lib/python3.12/site-packages/torio/lib"
            binary = torio / "_torio_ffmpeg6.so"
            sibling = torio / "libtorio_ffmpeg6.so"
            torio.mkdir(parents=True)
            binary.write_bytes(b"active backend ELF fixture")
            sibling.write_bytes(b"active companion ELF fixture")
            row = {
                "destination": str(sibling),
                "sha256": sha(sibling),
            }
            with patch.object(runtime, "run", return_value=f"\tlibtorio_ffmpeg6.so => {sibling} (0x1)"):
                runtime.ldd_closure(
                    [binary], runtime_root, runtime_root / "system-libs", [row], {"PATH": "/usr/bin:/bin"},
                    {"gigaam_pytorch/.venv/lib/python3.12/site-packages/torio/lib", "system-libs"},
                )
            self.assertFalse((runtime_root / "system-libs/libtorio_ffmpeg6.so").exists())

    def test_ldd_closure_resolves_active_torchaudio_core_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime_root = root / "runtime"
            library_dir = runtime_root / "gigaam_pytorch/.venv/lib/python3.12/site-packages/torchaudio/lib"
            binary = library_dir / "_torchaudio.so"
            sibling = library_dir / "libtorchaudio.so"
            library_dir.mkdir(parents=True)
            binary.write_bytes(b"active torchaudio ELF fixture")
            sibling.write_bytes(b"active torchaudio library fixture")
            row = {"destination": str(sibling), "sha256": sha(sibling)}
            with patch.object(runtime, "run", return_value=f"\tlibtorchaudio.so => {sibling} (0x1)"):
                runtime.ldd_closure(
                    [binary], runtime_root, runtime_root / "system-libs", [row], {"PATH": "/usr/bin:/bin"},
                    {"gigaam_pytorch/.venv/lib/python3.12/site-packages/torchaudio/lib", "system-libs"},
                )
            self.assertFalse((runtime_root / "system-libs/libtorchaudio.so").exists())

    def test_context_verifier_accepts_exact_payload_and_recipe_inventories(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)
            revision, _ = write_context_fixture(context, "app/services/local-ai/src/main.mjs", b"export {};\n")
            with patch.object(sys, "argv", ["verify-image-context.py", "--context", str(context), "--source-revision", revision]):
                self.assertEqual(context_verify.main(), 0)

    def test_context_verifier_rejects_mode_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)
            revision, payload = write_context_fixture(context, "app/services/local-ai/src/main.mjs", b"export {};\n")
            payload.chmod(0o600)
            with patch.object(sys, "argv", ["verify-image-context.py", "--context", str(context), "--source-revision", revision]):
                with self.assertRaisesRegex(ValueError, "payload hash mismatch"):
                    context_verify.main()

    def test_context_verifier_rejects_model_weight_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)
            revision, _ = write_context_fixture(context, "runtime/gigaam/pytorch_model.bin", b"fixture model bytes")
            with patch.object(sys, "argv", ["verify-image-context.py", "--context", str(context), "--source-revision", revision]):
                with self.assertRaisesRegex(ValueError, "unapproved vendor binary data"):
                    context_verify.main()

    def test_context_verifier_rejects_torchaudio_backend_accounting_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            context = Path(temp)
            revision, _ = write_context_fixture(context, "app/services/local-ai/src/main.mjs", b"export {};\n")
            inventory_path = context / "payload-inputs.json"
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            inventory["torchaudioAbiSelection"]["optionalSoxBackend"]["active"] = True
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            with patch.object(sys, "argv", ["verify-image-context.py", "--context", str(context), "--source-revision", revision]):
                with self.assertRaisesRegex(ValueError, "torchaudio core and optional-SoX"):
                    context_verify.main()

    def test_portable_manifest_copies_through_context_consumer(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime_root = root / "runtime-root"
            source_rel = "gigaam_pytorch/.venv/bin/python"
            source = runtime_root / source_rel
            source.parent.mkdir(parents=True)
            source.write_bytes(b"prepared portable interpreter fixture")
            row = {"source": source_rel, "destination": f"runtime/{source_rel}", "sha256": sha(source), "bytes": source.stat().st_size, "mode": f"{source.stat().st_mode & 0o7777:04o}"}
            provenance = {"source": "prepared-runtime-fixture", "destination": source_rel, "sha256": row["sha256"], "bytes": row["bytes"], "mode": row["mode"]}
            by_source = context_builder.validate_runtime_provenance([row], [provenance])
            context = root / "context"
            revision, _ = write_context_fixture(context, "app/services/local-ai/src/main.mjs", b"export {};\n")
            copied = context_builder.copy_runtime_inventory(runtime_root, context / "payload", [row], by_source)[0]
            inventory_path = context / "payload-inputs.json"
            manifest = json.loads(inventory_path.read_text())
            manifest["files"].append(copied)
            manifest["files"].sort(key=lambda item: item["path"])
            inventory_path.write_text(json.dumps(manifest), encoding="utf-8")
            sums = "".join(f"{item['sha256']}  {item['path']}\n" for item in manifest["files"])
            (context / "payload/SHA256SUMS").write_text(sums, encoding="utf-8")
            with patch.object(sys, "argv", ["verify-image-context.py", "--context", str(context), "--source-revision", revision]):
                self.assertEqual(context_verify.main(), 0)


if __name__ == "__main__":
    unittest.main()
