# ABOUTME: Проверяет составление двух native patches на закреплённом исходном engine.
# ABOUTME: Все изменения и компиляция выполняются только во временном каталоге.
import hashlib
import json
import os
from pathlib import Path
import py_compile
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RELEASE = Path('/opt/brai-identity/dev/software/release-fb5e7fb91bee427182e4da0f56466b3a')
ENGINE = os.environ.get('BRAI_COMPOSITION_BASE_ENGINE')
OLD_PATCH = RELEASE / 'runtime/services/hermes/identity/native.patch'
OLD_SHA256 = 'cd9179217739bfd43bcce9e273aebc7f2532e92dac8bb10d69692384ef91f286'
IDENTITY = ROOT / 'identity/native.patch'
BUDGET = ROOT / 'extensions/patches/turn-request-budget.patch'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def targets(patches):
    paths = set()
    for patch in patches:
        for line in patch.read_text().splitlines():
            if not line.startswith(('--- ', '+++ ')):
                continue
            name = line[4:].split('\t', 1)[0]
            if name == '/dev/null':
                continue
            if not name.startswith(('a/', 'b/')):
                raise ValueError('unsupported patch path')
            path = Path(name[2:])
            if path.is_absolute() or '..' in path.parts or path.suffix != '.py':
                raise ValueError('unsupported patch target')
            paths.add(path)
    return paths


def apply_patch(stage, patch):
    data = patch.read_bytes()
    for command in (['git', 'apply', '--check', '-'], ['git', 'apply', '-']):
        result = subprocess.run(command, cwd=stage, input=data,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if result.returncode:
            raise AssertionError(f'{patch.name}: {result.stdout.decode(errors="replace")}')
    if list(stage.rglob('*.rej')):
        raise AssertionError('patch produced rejects')


def snapshot(stage, paths):
    return {str(path): (stage / path).read_bytes() if (stage / path).is_file() else None
            for path in paths}


def modes(stage, paths):
    return {str(path): stat.S_IMODE((stage / path).stat().st_mode) & 0o111
            if (stage / path).is_file() else None for path in paths}


class NativeCompositionTests(unittest.TestCase):
    def test_qualified_bare_baseline_composes_in_both_orders(self):
        if not ENGINE or not OLD_PATCH.is_file():
            self.skipTest('qualified bare engine or old identity patch is not available')
        engine = Path(ENGINE)
        self.assertTrue(engine.is_dir(), 'qualified bare engine is not a directory')
        self.assertEqual(digest(OLD_PATCH.read_bytes()), OLD_SHA256,
                         'installed identity patch differs from qualified baseline')
        paths = targets((OLD_PATCH, IDENTITY, BUDGET))
        self.assertTrue(paths)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'base'
            base.mkdir()
            baseline = {}
            for path in sorted(paths):
                source = engine / path
                if source.is_file():
                    target = base / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                    target.chmod(target.stat().st_mode | stat.S_IWUSR)
                    baseline[str(path)] = {
                        'sha256': digest(source.read_bytes()),
                        'executable': bool(source.stat().st_mode & 0o111),
                    }
                else:
                    baseline[str(path)] = None
            print('composition_baseline=' + json.dumps({
                'source_mode': 'bare', 'old_patch_sha256': OLD_SHA256,
                'identity_patch_sha256': digest(IDENTITY.read_bytes()),
                'budget_patch_sha256': digest(BUDGET.read_bytes()),
                'targets': baseline,
            }, sort_keys=True))
            outputs = []
            for index, order in enumerate(((IDENTITY, BUDGET), (BUDGET, IDENTITY))):
                stage = Path(tmp) / str(index)
                shutil.copytree(base, stage)
                for patch in order:
                    apply_patch(stage, patch)
                outputs.append((snapshot(stage, paths), modes(stage, paths)))
                for path in sorted(paths):
                    target = stage / path
                    if target.is_file():
                        py_compile.compile(str(target), doraise=True)
            self.assertEqual(outputs[0], outputs[1],
                             'patch order changed target bytes or executable bits')


if __name__ == '__main__':
    unittest.main()
