# ABOUTME: Запускает неизменный сборщик принятой версии над ограниченным пакетом JSON.
# ABOUTME: Временные файлы удаляются; к БД, сети и человеческим решениям доступа нет.
import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('planning_system', Path(__file__).with_name('planning-system.py'))
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def run(value):
    """Проверить критерии, собрать кандидат и при наличии review выдать квитанцию."""
    if 'expand_stage' in value:
        return {'stage': planner.expand_repeat(value['expand_stage'], value['move_id'], value['binding'])}
    with TemporaryDirectory(prefix='brai-plan-') as directory:
        root = Path(directory).resolve()
        for name, content in value['files'].items():
            path = planner.local(root, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        planner.save(root / 'criteria.json', value['baseline'])
        planner.bind(root, 'packet.json', 'criteria.json')
        if 'candidate' not in value:
            return {'baseline_sha256': planner.sha(root / 'criteria.json')}
        planner.save(root / 'candidate.json', value['candidate'])
        planner.build(root, 'packet.json', 'candidate.json', 'plan')
        result = {'stage': planner.load(root / 'plan.json'), 'markdown': (root / 'plan.md').read_text(),
                  'manifest': planner.load(root / 'plan.manifest.json'),
                  'baseline_sha256': planner.sha(root / 'criteria.json'), 'candidate_sha256': planner.sha(root / 'candidate.json')}
        if 'review' in value:
            planner.save(root / 'review.json', value['review'])
            planner.release(root, 'plan.manifest.json', 'criteria.json', 'review.json', 'receipt.json')
            result['receipt'] = planner.load(root / 'receipt.json')
        return result


try:
    raw = sys.stdin.buffer.read(524289)
    if len(raw) > 524288:
        raise ValueError('Пакет слишком велик')
    print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
except (ValueError, KeyError, TypeError, AssertionError) as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=False))
    sys.exit(2)
