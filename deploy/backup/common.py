# ABOUTME: Общие операции закрытого набора восстановления Brai.
# ABOUTME: Ошибки внешних команд не раскрывают SQL, credentials или содержимое файлов.
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


class Failure(RuntimeError):
    """Прервать сборку; context содержит только выбранные метаданные ресурса."""

    def __init__(self, code, **context):
        """Сохранить безопасный код и сведения для оператора без argv внешней команды."""
        super().__init__(code)
        self.context = context


def js(path):
    """Прочитать JSON из указанного доверенного файла."""
    return json.loads(Path(path).read_text())


def digest(path):
    """Посчитать SHA-256 потоково, не загружая файл целиком в память."""
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    """Атомарно записать root-only JSON и синхронизировать родительский каталог."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.recovery-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, ensure_ascii=False, sort_keys=True, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def qi(value):
    """Экранировать SQL identifier без интерполяции SQL операторов."""
    return '"' + value.replace('"', '""') + '"'


def run(argv, *, output=None, data=None, input_file=None, check=True):
    """Запустить argv без shell и нового ограничения времени; диагностику не публиковать."""
    result = subprocess.run([str(a) for a in argv], input=data, stdin=input_file,
                            stdout=output if output is not None else subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    if check and result.returncode:
        raise Failure('RECOVERY_COMMAND_FAILED')
    return result.stdout if check else result.returncode
