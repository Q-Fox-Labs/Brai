# ABOUTME: Проверяет реальную модель на независимых примерах отбора и классификации.
# ABOUTME: Все тексты синтетические; MemOS не вызывается и память не изменяется.
"""Live semantic qualification without any memory writes."""
import argparse
import importlib
import json
import sys
import types
from pathlib import Path


def main():
    """Сверить назначение, отбрасывание шума и отсутствие лишних сфер."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--plugin-root', required=True)
    parser.add_argument('--config-path', required=True)
    args = parser.parse_args()
    package = types.ModuleType('memory_quality_candidate')
    package.__path__ = [args.plugin_root]
    sys.modules[package.__name__] = package
    module = importlib.import_module(package.__name__ + '.router')
    config = json.loads(Path(args.config_path).read_text())
    router = module.SemanticRouter(config['router'], module.Catalog(Path('/nonexistent-neutral-profile')))
    cases = [
        ('business_research', 'На странице FOHOW прочитал характеристики аппарата и отзывы. В PubMed публикаций по этому названию не нашёл.',
         ['Выбираю массажный аппарат для своего кабинета, хочу развивать платные услуги.'], 'life_work', ['life_intellect']),
        ('vehicle', 'В моей машине загорелась лампа давления масла. Решил отвезти её в сервис на эвакуаторе.', [], 'life_comfort', ['life_body']),
        ('kitchen', 'На моей кухне есть духовка, микроволновка и блендер.', [], 'life_comfort', ['infra']),
        ('branding', 'Я выбрал название «Культура заботы о теле».', ['Выбираю название для своего массажного бизнеса.'], 'life_work', ['life_vividness']),
        ('thanks', 'Спасибо, Брай. Благодарю за сегодняшний день. До завтра!', [], None, []),
        ('acknowledgement', 'Принимаю план.', [], None, []),
        ('test_trace', 'TEST smoke завершён. Опубликован тестовый artifact, input.json содержит 42 и слово «маяк».', [], None, []),
        ('education', 'Изучаю философию ради собственного понимания мира, это не связано с работой.', [], 'life_intellect', ['life_work']),
        ('assistant_research', 'В инструкции массажного аппарата указана частота 1 МГц, а на рекламной странице — 20 кГц; данные противоречат друг другу.',
         ['Проверяем аппарат для развития платных массажных услуг.'], 'life_work', ['life_intellect']),
        ('asset_decision', 'Я решил отказаться от этого участка.', ['Обсуждаем мой земельный участок как личную инвестицию для перепродажи.'], 'life_capital', []),
    ]
    failures = []
    transport = router.transport
    captured = []
    def capture(payload):
        result = transport(payload)
        captured.append(result)
        return result
    router.transport = capture
    for name, text, context, expected, forbidden in cases:
        try:
            facts = router.extract([{'role': 'assistant' if name.startswith('assistant_') else 'user', 'content': text}], context=context)
        except module.MemOSError:
            print(json.dumps({'case': name, 'neutral_fixture_response': captured[-1:]}, ensure_ascii=False),flush=True)
            raise
        spheres = {s for f in facts for s in f['spheres']}
        ok = (not facts if expected is None else expected in spheres) and not spheres.intersection(forbidden)
        if not ok:
            failures.append(name)
            print(json.dumps({'case':name,'neutral_fixture_response':captured},ensure_ascii=False),flush=True)
        captured.clear()
        print(json.dumps({'case': name, 'passed': ok, 'facts': len(facts), 'spheres': sorted(spheres)}, ensure_ascii=False), flush=True)
    # AIDEV-NOTE: Контрольные тексты не повторяют формулировки запросов и не
    # содержат ответов, которые модель сама сгенерировала в ходе этой проверки.
    corpus = [
        {'text': 'Предпочитаю название «Тихая гавань» для своего массажного кабинета.', 'kind': 'fact', 'status': 'preference'},
        {'text': 'Обсуждались названия «Речной берег» и «Тихая гавань», выбор ещё не сделан.', 'kind': 'fact', 'status': 'idea'},
        {'text': 'Хочу продать участок за городом и купить автомобиль.', 'kind': 'fact', 'status': 'plan'},
        {'text': 'У меня аппарат «Вектор 4». Первая процедура с диагностикой — 3 500 рублей.', 'kind': 'fact', 'status': 'observation'},
        {'text': 'Мой автомобиль потребляет много масла.', 'kind': 'fact', 'status': 'observation'},
        {'text': 'Брай, запомни эти варианты. Запомнишь?', 'kind': 'fact', 'status': 'unknown'},
        {'text': 'Прочитана страница производителя массажного оборудования.', 'kind': 'fact', 'status': 'reported_done'},
    ]
    retrieval_cases = [
        ('preferred_name', 'Какое имя мастер предпочитает для своего массажного бизнеса?', {0}),
        ('equipment_price', 'Каким аппаратом пользуется мастер и во сколько обойдётся первый приём?', {3}),
        ('absent_subject', 'Как откалибровать детектор нейтрино?', set()),
    ]
    for name, question, required in retrieval_cases:
        result = router.rank(question, corpus)
        direct = {m['index'] for m in result['matches'] if m['relevance'] == 'direct'}
        found = {m['index'] for m in result['matches']}
        ok = direct == required and not (found - (required | ({1} if name == 'preferred_name' else set())))
        if not ok:
            failures.append(name)
        print(json.dumps({'case': name, 'passed': ok, 'direct': sorted(direct),
                          'selected': sorted(found)}, ensure_ascii=False), flush=True)
    print(json.dumps({'failures': failures, 'memos_writes': 0}), flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
