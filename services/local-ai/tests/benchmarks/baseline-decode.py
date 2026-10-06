#!/usr/bin/env python3
# ABOUTME: Измеряет probe/decode существующего GigaAM runner без изменения его вычислений.
# ABOUTME: Пишет только фиксированные stage и миллисекунды; содержимое и stderr не передаёт.
import importlib.util
import json
import sys
import time
from pathlib import Path

source = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source.parent))
spec = importlib.util.spec_from_file_location('baseline_runner', source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

def timed(name, operation):
    """Обернуть существующий этап, сохранив его вход, результат и исключения."""
    def call(*args, **kwargs):
        started = time.perf_counter()
        try:
            return operation(*args, **kwargs)
        finally:
            print('BASELINE_STAGE ' + json.dumps({'stage': name, 'durationMs': (time.perf_counter() - started) * 1000}), file=sys.stderr, flush=True)
    return call

runner._audio_duration = timed('probe', runner._audio_duration)
runner._decode_audio_to_wav = timed('decode', runner._decode_audio_to_wav)
raise SystemExit(runner.main(sys.argv[2:]))
