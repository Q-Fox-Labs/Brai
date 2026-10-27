"""Read-only bridge qualification. Never calls or writes to MemOS."""
import argparse
import importlib
import json
import sys
from pathlib import Path

import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hermes-root', required=True)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--key-env', default='MEMOS_BRIDGE_TOKEN')
    parser.add_argument('--model', default='gpt-6-luna')
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.hermes_root).resolve()))
    from plugins.memory import load_memory_provider
    provider = load_memory_provider('memos-rest', register_skills=False)
    module = importlib.import_module(provider.__class__.__module__.rsplit('.', 1)[0] + '.router')
    fixture = tempfile.TemporaryDirectory(prefix='memos-neutral-router-')
    catalog = module.Catalog(Path(fixture.name))
    router = module.SemanticRouter({'base_url': args.base_url, 'model': args.model,
                         'env_file': args.env_file, 'api_key_env': args.key_env, 'timeout': 120}, catalog)
    cases = [
        ('Изучаю техники продаж, чтобы лучше понимать процесс.', 'life_intellect'),
        ('Сегодня применил изученную технику в продаже заказа клиенту.', 'life_work'),
        ('Хочу настроить автополив, чтобы он надёжно работал каждую неделю.', 'life_systems'),
        ('Наблюдаю звёзды через телескоп ради удовольствия.', 'life_vividness'),
        ('Перевёл прибыль бизнеса на личный инвестиционный счёт.', 'life_capital'),
        ('Предпочитаю короткие ответы без вступлений.', 'user'),
    ]
    rows = [{'role': 'user', 'content': text} for text, _ in cases]
    rows.append({'role': 'assistant', 'content': 'Я выполнил настройку сервера.'})
    output = []
    transport = router.transport
    def capture(payload):
        result = transport(payload)
        output.append(result)
        return result
    router.transport = capture
    try:
        facts = router.extract(rows)
    except module.MemOSError:
        print(json.dumps({'validation_failed': True, 'neutral_fixture_response': output, 'memos_writes': 0}, ensure_ascii=False, indent=2))
        raise
    failures = []
    for i, (_, expected) in enumerate(cases):
        routed = [f for f in facts if f['source']['message_index'] == i]
        if not any(expected in f['spheres'] for f in routed):
            failures.append({'message_index': i, 'expected': expected})
    if any(f['status'] == 'verified_done' for f in facts):
        failures.append({'status': 'unproven_verified_done'})
    print(json.dumps({'model': args.model, 'facts': facts, 'failures': failures,
                      'memos_writes': 0}, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
