"""Файловая сборка предварительных планов. Не runtime и не клиент БД."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import uuid

FIELDS = ('title summary inputs context scope constraints preferences unknowns hypothesis '
          'expected_result result_types outputs').split()
LABELS = ('Заголовок|Короткое описание|Входные ресурсы|Контекст|Границы|Ограничения|'
          'Предпочтения|Неизвестное|Гипотеза|Ожидаемый результат|Типы результата|Выходные ресурсы').split('|')
KINDS = {'Квест': 'Цель', 'Цель': 'Задача', 'Задача': None}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def uid(owner, key):
    return str(uuid.uuid5(uuid.UUID(owner), key))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    require(not path.exists(), 'Нельзя перезаписывать версию: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def local(root, name):
    p = (root / name).resolve()
    require(p.is_relative_to(root) and p != root, 'Путь вне прогона')
    return p


def fields(value):
    require(isinstance(value, dict) and set(value) == set(FIELDS), 'Нужны ровно 12 полей Элемента')
    for name in FIELDS:
        if name in {'inputs', 'outputs', 'result_types'}:
            require(isinstance(value[name], list) and all(isinstance(x, str) for x in value[name]), name + ': нужен список строк')
            require(len(value[name]) == len(set(value[name])), name + ': повтор ссылки')
        else:
            require(isinstance(value[name], str), name + ': нужна строка')
    require(set(value['result_types']) <= {'Выбор', 'Артефакт'}, 'Неизвестный тип результата')
    intent = [bool(value['title'].strip()), bool(value['expected_result'].strip()), bool(value['outputs'])]
    require(all(intent) or not any(intent), 'Неполный контракт итога')
    if not any(intent):
        require(not value['hypothesis'] and not value['result_types'], 'Гипотеза не угадывает неизвестный итог')


def result_chain(plan):
    """Один узел — одна граница работы; вспомогательные выходы не создают узлов."""
    units = plan['work'] or plan['children']
    outputs = {u['key']: u.get('outputs', u.get('fields', {}).get('outputs', [])) for u in units}
    inputs = {u['key']: u.get('inputs', u.get('fields', {}).get('inputs', [])) for u in units}
    producers = {}
    for key, refs in outputs.items():
        for ref in refs:
            require(ref not in producers, 'Несколько производителей результата')
            producers[ref] = key
    chain, seen, used = [], {}, set()
    require(isinstance(plan['chain'], list), 'Нужна цепочка результатов')
    for node in plan['chain']:
        require(isinstance(node, dict) and set(node) in ({'result', 'after'}, {'result', 'after', 'each'}), 'Неверный узел результата')
        ref, after = node['result'], node['after']
        require(isinstance(ref, str) and ref in producers and ref not in seen, 'Нет производителя узла результата или повтор узла')
        key = producers[ref]
        require(key not in used, 'Два самостоятельных результата склеены в одном Ходе или ребёнке')
        require(isinstance(after, list) and all(isinstance(r, str) and r in seen for r in after) and len(after) == len(set(after)), 'Цикл, повтор или неизвестный предшествующий результат')
        require(all(set(outputs[seen[r]]) & set(inputs[key]) for r in after), 'Зависимость результата не передана входным ресурсом')
        require({producers[r] for r in inputs[key] if r in producers} == {seen[r] for r in after}, 'В цепочке пропущена ресурсная зависимость')
        if 'each' in node:
            require(bool(plan['work']) and isinstance(node['each'], str) and node['each'] in inputs[key], 'Повторение требует входного перечня и шаблона Хода')
        chain.append(dict(node, by=key))
        seen[ref] = key
        used.add(key)
    require(used == set(outputs), 'Цепочка не покрывает все Ходы или детей')
    require([n['by'] for n in chain] == [u['key'] for u in units], 'Порядок карточек отличается от цепочки результатов')
    return chain


def compile_plan(packet, plan):
    """Только предметный план; служебные записи создаёт эта функция."""
    require(set(plan) == {'fields', 'resources', 'children', 'work', 'completion', 'questions', 'deferred', 'chain'}, 'Неверный состав предметного плана')
    fields(plan['fields'])
    clear = bool(plan['fields']['outputs'])
    eid, kind = packet['element']['id'], packet['element']['kind']
    require(kind in KINDS or (kind is None and not clear), 'Неизвестный уровень')
    uuid.UUID(eid)
    op, finish = packet['operation'], packet['finish']
    require(op['target'] == finish['target'] == eid, 'Граница относится к другому Элементу')
    require(op['owner'] == finish['owner'] == (packet['element']['parent'] or eid), 'Неверный владелец границ')
    uuid.UUID(op['id']); uuid.UUID(finish['id'])
    children, work = plan['children'], plan['work']
    require(isinstance(children, list) and isinstance(work, list), 'Нужны списки детей и работы')
    require(((not children and bool(work)) if kind == 'Задача' else (2 <= len(children) <= 6 and not work)) if clear else not children and not work, 'Минимальный уровень или число детей нарушены')
    chain = result_chain(plan)
    repetitions = {n['by']: n['each'] for n in chain if 'each' in n}
    catalog = {r['id']: copy.deepcopy(r) for r in packet['resources']}
    require(len(catalog) == len(packet['resources']), 'Повтор ресурса в пакете')
    for resource in catalog.values():
        uuid.UUID(resource['id'])
        require(resource['state'] in {'given', 'expected'}, 'Неизвестная доступность ресурса')
    symbols = {key: key for key in catalog}
    definitions = {}
    keys = []
    for category in ('resources', 'children', 'work'):
        for item in plan[category]:
            key = item['key']
            require(isinstance(key, str) and key.strip() and key not in symbols and key not in keys, 'Повтор или пустая локальная ссылка')
            keys.append(key)
            symbols[key] = uid(eid, category + ':' + key)
            if category == 'resources':
                require(set(item) == {'key', 'name', 'content'} and item['name'].strip() and item['content'].strip(), 'Неверное определение ресурса')
                rid = symbols[key]
                catalog[rid] = {'id': rid, 'name': item['name'], 'content': item['content'], 'state': 'expected', 'producer': None}
                definitions[key] = rid
    def refs(values):
        require(isinstance(values, list) and all(isinstance(v, str) and v in symbols for v in values), 'Неизвестная ресурсная ссылка')
        resolved = [symbols[v] for v in values]
        require(all(v in catalog for v in resolved) and len(resolved) == len(set(resolved)), 'Ссылка не на ресурс или повтор ссылки')
        return resolved
    current = copy.deepcopy(plan['fields'])
    current['inputs'], current['outputs'] = refs(current['inputs']), refs(current['outputs'])
    require(current['inputs'] == packet['draft']['inputs'], 'Входы изменены без источника')
    if packet['draft']['outputs']:
        require(current['outputs'] == packet['draft']['outputs'], 'Изменён контракт результата ребёнка')
    require(not set(current['inputs']) & set(current['outputs']), 'Собственный итог потребован на входе')
    require(all(x in catalog for x in current['inputs']), 'Вход отсутствует в пакете')
    available = set(current['inputs'])
    producers = {}
    def produce(outputs, move):
        for rid in outputs:
            require(rid not in available and rid not in producers, 'Ресурс имеет несколько производителей или уже существует')
            require(rid in definitions.values() or rid in packet['draft']['outputs'], 'Нельзя переопределить переданный ресурс')
            producers[rid] = move
            catalog[rid]['producer'] = move
            available.add(rid)
    moves = []
    view = [op['id']]
    previous = op['id']
    def system_resource(target, purpose, name, producer):
        rid = uid(target, 'system:' + purpose)
        catalog[rid] = {'id': rid, 'name': name, 'content': name + ' для Элемента ' + target,
                        'state': 'expected', 'producer': producer}
        return rid
    draft_resource = system_resource(eid, 'draft', 'Постановка и план Ходов', op['id'])
    confirmed = system_resource(eid, 'confirmed', 'Подтверждённая постановка', uid(eid, 'confirm'))
    decision_resource = system_resource(eid, 'decision', 'Итоговое решение Игрока', None)
    def add(mid, title, actor, target, purpose, inputs=(), outputs=(), instruction='', criteria=(), owner=None, decision=None):
        nonlocal previous
        m = {'id': mid, 'owner': owner or eid, 'target': target, 'title': title,
             'actor': actor, 'purpose': purpose, 'previous': previous, 'inputs': list(inputs),
             'outputs': list(outputs), 'instruction': instruction, 'criteria': list(criteria),
             'requires_confirmation': purpose not in {'confirm', 'accept'}, 'decision': decision,
             'status': 'planned'}
        if m['requires_confirmation']:
            m['inputs'] = list(dict.fromkeys(m['inputs'] + [confirmed]))
        if purpose == 'accept':
            m['wait_decision'] = target
            dr = system_resource(target, 'decision', 'Итоговое решение Игрока', None)
            m['inputs'].append(dr)
        moves.append(m); view.append(mid); previous = mid
        return m
    require(isinstance(plan['questions'], list) and all(isinstance(q, str) and q.strip() for q in plan['questions']), 'Неверные вопросы')
    add(uid(eid, 'confirm'), 'Рассмотреть постановку', 'player', eid, 'confirm',
        inputs=[draft_resource],
        outputs=[confirmed],
        instruction='Рассмотреть план и подтвердить постановку. ' + ' '.join(plan['questions']),
        criteria=['Постановка подтверждена либо сохранены замечания или итоговое решение'], decision='confirm')
    if not clear:
        require(plan['questions'] and not plan['resources'] and not plan['completion'] and not plan['deferred'], 'Неясный итог требует вопросов, а не выдуманного плана')
        del catalog[decision_resource]
        catalog[confirmed]['name'] = 'Ответы Игрока для постановки'
        catalog[confirmed]['content'] = 'Уточнение порученного итога'
        moves[-1].update(title='Уточнить поручение', decision='clarify', instruction=' '.join(plan['questions']),
                         criteria=['Сохранены ответы о порученном результате'])
        updated = system_resource(eid, 'updated-draft', 'Уточнённая постановка', uid(eid, 'update'))
        m = add(uid(eid, 'update'), 'Оформить уточнённую постановку', 'agent', eid, 'update', [confirmed], [updated],
                instruction='По ответам определить итог и оформить предметный план. Пройти независимую проверку. Новый план потребует отдельного подтверждения Игрока.',
                criteria=['План оформлен и принят проверкой; исполнение ждёт подтверждения'])
        m['requires_confirmation'] = False
        return {'element': dict(packet['element'], fields=current), 'operation': copy.deepcopy(op),
                'records': moves, 'finish': copy.deepcopy(finish), 'view': view, 'resources': list(catalog.values()),
                'children': [], 'symbols': symbols, 'deferred': [], 'chain': [], 'awaiting_clarification': True}
    child_packets = []
    for child in children:
        require(set(child) == {'key', 'kind', 'fields'} and child['kind'] == KINDS[kind], 'Неверный тип ребёнка')
        fields(child['fields'])
        cf = copy.deepcopy(child['fields'])
        cf['inputs'], cf['outputs'] = refs(cf['inputs']), refs(cf['outputs'])
        require(set(cf['inputs']) <= available, 'Ребёнок ждёт ресурс без предшествующего производителя')
        cid = symbols[child['key']]
        start = add(uid(cid, 'start'), 'Поставить: ' + cf['title'], 'agent', cid, 'plan', cf['inputs'],
                    instruction='Прочитать пакет ребёнка и общие правила. Вернуть предметный план, пройти независимую проверку; существующие граничные Операции не создавать.',
                    criteria=['Предметный план и системная сборка приняты независимой проверкой'])
        start['outputs'] = [system_resource(cid, 'draft', 'Постановка и план Ходов', start['id'])]
        end = add(uid(cid, 'finish'), 'Принять: ' + cf['title'], 'agent', cid, 'accept', outputs=cf['outputs'],
                  instruction='Зафиксировать итоговое решение именно по ребёнку, основания и принятые ресурсы. Закрыть ребёнка.',
                  criteria=['Решение относится к этому ребёнку; принятый итог сохранён'])
        produce(cf['outputs'], end['id'])
        child_packets.append({'key': child['key'], 'element': {'id': cid, 'kind': child['kind'], 'parent': eid},
                              'operation': copy.deepcopy(start), 'finish': copy.deepcopy(end), 'draft': cf})
    deferred = {}
    require(isinstance(plan['deferred'], list), 'Неверное отложенное продолжение')
    for item in plan['deferred']:
        require(set(item) == {'after', 'missing', 'scope'} and item['missing'].strip() and item['scope'].strip(), 'Нет основания отложенной части')
        require(item['after'] in [w['key'] for w in work] and item['after'] not in deferred, 'Нет результата раскрытия или повтор раскрытия')
        require(item['after'] not in repetitions, 'Перечень раскрывается повторением, а не неизвестной постановкой')
        deferred[item['after']] = item
    for w in work:
        require(set(w) == {'key', 'title', 'actor', 'description', 'instruction', 'inputs', 'outputs', 'criteria'}, 'Неверные поля предметного Хода')
        require(w['actor'] in {'agent', 'player'}, 'Неизвестный исполнитель')
        require(all(isinstance(w[k], str) and w[k].strip() for k in ('title', 'description', 'instruction')), 'Пустой предметный Ход')
        require(isinstance(w['criteria'], list) and w['criteria'] and all(isinstance(x, str) and x.strip() for x in w['criteria']), 'Нет проверяемого результата')
        inputs, outputs = refs(w['inputs']), refs(w['outputs'])
        require(outputs and set(inputs) <= available, 'Нет выхода либо вход получен после использования')
        m = add(symbols[w['key']], w['title'], w['actor'], eid, 'work', inputs, outputs, w['instruction'], w['criteria'])
        m['description'] = w['description']
        if w['key'] in repetitions:
            m['template'] = copy.deepcopy(m)
            m.update(actor='agent', purpose='expand-repeat', repeat_over=refs([repetitions[w['key']]])[0],
                     title='Раскрыть повторение: ' + w['title'], executable=False,
                     instruction='По фактическому перечню создать отдельный Ход для каждого объекта. Собирать общий результат только после всех Ходов.')
        produce(outputs, m['id'])
        if w['key'] in deferred:
            d = deferred[w['key']]
            expanded = system_resource(eid, 'expanded:' + w['key'], 'Постановка неизвестного продолжения', uid(eid, 'expand:' + w['key']))
            add(uid(eid, 'expand:' + w['key']), 'Поставить неизвестное продолжение', 'agent', eid, 'expand', outputs,
                outputs=[expanded],
                instruction='После получения данных: ' + d['missing'] + '. Спланировать только: ' + d['scope'] + '. Получить отдельное подтверждение нового плана.',
                criteria=['Новый план принят проверкой и ожидает подтверждения Игрока'])
    completion = refs(plan['completion'])
    require(completion and set(completion) <= available, 'Нет основания конечного ресурса')
    for child in child_packets:
        require(set(child['draft']['outputs']) & set(completion), 'Итог ребёнка не участвует в общем результате')
    if kind != 'Задача' or moves[-1]['actor'] != 'player' or moves[-1]['purpose'] != 'work':
        add(uid(eid, 'review-result'), 'Рассмотреть итог', 'player', eid, 'review', completion,
            outputs=[decision_resource],
            instruction='Оценить результат и принять итоговое решение по этому Элементу.', criteria=['Сохранено итоговое решение с основаниями'], decision='final')
    else:
        moves[-1]['decision'] = 'final'
        moves[-1]['outputs'].append(decision_resource)
    catalog[decision_resource]['producer'] = moves[-1]['id']
    require(not set(current['outputs']) & available, 'Итог приёмки создан до приёмки')
    own_end = copy.deepcopy(finish)
    own_end.update({'title': 'Принять итог: ' + current['title'], 'actor': 'agent', 'purpose': 'accept',
                    'previous': previous, 'inputs': completion + [decision_resource], 'outputs': current['outputs'],
                    'wait_decision': eid, 'decision': None, 'requires_confirmation': False, 'status': 'planned',
                    'instruction': 'Зафиксировать решение Игрока, основания и принятый итог. Закрыть этот Элемент.',
                    'criteria': ['Есть итоговое решение именно по этому Элементу; результат сохранён']})
    produce(current['outputs'], own_end['id'])
    require(set(definitions.values()) <= set(producers), 'Объявлен ресурс без производителя')
    view.append(own_end['id'])
    if not packet['element']['parent']:
        moves.append(own_end)
    for child in child_packets:
        selection = set(child['draft']['inputs'] + child['draft']['outputs'])
        child['resources'] = [copy.deepcopy(r) for rid, r in catalog.items() if rid in selection]
        child['context_files'], child['rules'] = packet['context_files'], packet['rules']
    return {'element': dict(packet['element'], fields=current), 'operation': copy.deepcopy(op),
            'records': moves, 'finish': own_end, 'view': view, 'resources': list(catalog.values()),
            'children': child_packets, 'symbols': symbols, 'deferred': plan['deferred'],
            'chain': [dict(n, result=symbols[n['result']], after=[symbols[r] for r in n['after']],
                           by=symbols[n['by']], **({'each': symbols[n['each']]} if 'each' in n else {})) for n in chain]}


def expand_repeat(stage, move_id, binding):
    """Привязывает известный шаблон к фактическому перечню. Работу не исполняет."""
    result = copy.deepcopy(stage)
    matches = [m for m in result['records'] if m['id'] == move_id and m['purpose'] == 'expand-repeat']
    require(len(matches) == 1, 'Нет нераскрытого повторения')
    marker = matches[0]
    require(set(binding) == {'resource', 'items'} and binding['resource'] == marker['repeat_over'], 'Перечень относится к другому ресурсу')
    items = binding['items']
    require(isinstance(items, list), 'Нужен фактический перечень объектов')
    ids = []
    for item in items:
        require(set(item) == {'id', 'label'} and isinstance(item['label'], str) and item['label'].strip(), 'Объекту нужны устойчивый ID и название')
        uuid.UUID(item['id']); ids.append(item['id'])
    require(len(ids) == len(set(ids)), 'Повтор объекта в перечне')
    catalog = {r['id']: r for r in result['resources']}
    inserted, collected, previous = [], [], marker['previous']
    for item in items:
        instance = copy.deepcopy(marker['template'])
        instance.update(id=uid(move_id, 'item:' + item['id']), previous=previous, item=item, decision=None)
        instance['title'] += ': ' + item['label']
        instance['outputs'] = []
        for resource_id in marker['outputs']:
            resource = dict(catalog[resource_id], id=uid(resource_id, 'item:' + item['id']),
                            name=catalog[resource_id]['name'] + ': ' + item['label'], producer=instance['id'])
            result['resources'].append(resource)
            instance['outputs'].append(resource['id'])
            collected.append(resource['id'])
        inserted.append(instance); previous = instance['id']
    marker.pop('template')
    marker.update(purpose='collect', previous=previous, inputs=list(dict.fromkeys(marker['inputs'] + collected)),
                  executable=True, items=ids, instruction='Проверить результаты всех объектов принятого перечня и собрать общий ресурс.')
    index = result['records'].index(marker)
    result['records'][index:index] = inserted
    index = result['view'].index(move_id)
    result['view'][index:index] = [m['id'] for m in inserted]
    return result


def markdown(stage):
    catalog = {r['id']: r['name'] for r in stage['resources']}
    def text(value):
        if isinstance(value, list):
            value = '; '.join(catalog.get(x, x) for x in value)
        return str(value).replace('|', '\\|').replace('\n', '<br>')
    def table(pairs):
        return '| Поле | Значение |\n| --- | --- |\n' + ''.join('| ' + k + ' | ' + text(v) + ' |\n' for k, v in pairs)
    out = '# ' + stage['element']['fields']['title'] + '\n\n'
    out += table([(label, stage['element']['fields'][key]) for key, label in zip(FIELDS, LABELS)])
    out += '\n## Цепочка результатов\n\n| Результат | После | Повторение |\n| --- | --- | --- |\n'
    out += ''.join('| ' + text([n['result']]) + ' | ' + text(n['after']) + ' | ' + text([n['each']] if 'each' in n else '') + ' |\n' for n in stage['chain'])
    records = {r['id']: r for r in stage['records']}
    records[stage['finish']['id']] = stage['finish']
    out += '\nСуществующая Операция постановки: ' + stage['operation']['id'] + '.\n'
    for number, mid in enumerate(stage['view'][1:], 2):
        m = records[mid]
        extra = ''
        if m['actor'] == 'player':
            extra = ' Успех: сохранить результат; замечания: сохранить требование доработки; завершить: сохранить итоговое решение с основаниями.'
        if m.get('decision') == 'final':
            extra += ' Успех включает итоговое решение по Элементу ' + m['target'] + '.'
        condition = ('Есть итоговое решение Игрока по Элементу ' + m['target']) if m['purpose'] == 'accept' else ('Доступен план для рассмотрения' if m['purpose'] == 'confirm' else 'Есть актуальная подтверждённая постановка; доступны входные ресурсы')
        out += '\n## ' + str(number) + '. ' + m['title'] + '\n\n'
        out += table(list(zip(('Временный ID|Заголовок|Тип|Роль|Описание|Предыдущий Ход|Входные ресурсы|Инструкция|Границы|Ожидаемый выход|Критерии завершения|Условие запуска').split('|'),
            [m['id'], m['title'], 'Экшен' if m['actor'] == 'player' else 'Операция', 'Игрок' if m['actor'] == 'player' else 'Агент', m.get('description', m['purpose']), m['previous'], m['inputs'], m.get('instruction', '') + extra, stage['element']['fields']['scope'], m['outputs'], m.get('criteria', []), condition])))
    out += '\n## Ресурсы\n\n| Название | Содержание | Состояние |\n| --- | --- | --- |\n'
    out += ''.join('| ' + text(r['name']) + ' | ' + text(r['content']) + ' | ' + r['state'] + ' |\n' for r in stage['resources'])
    return out


def packet_inputs(root, packet_name):
    packet = load(local(root, packet_name))
    names = list(dict.fromkeys([packet_name] + packet['context_files'] + packet['rules']))
    return packet, {name: sha(local(root, name)) for name in names}


def independent_requirements(root, packet_name, baseline_name):
    packet, inputs = packet_inputs(root, packet_name)
    baseline = load(local(root, baseline_name))
    require(baseline['inputs'] == inputs, 'Проверяющий получил другой пакет')
    requirements = {r['id']: r for r in baseline['requirements']}
    require(requirements and len(requirements) == len(baseline['requirements']), 'Нет независимых требований или повтор ID')
    for item in requirements.values():
        require(item['text'].strip() and item['source_file'] in inputs and item['quote'].strip() and item['quote'] in local(root, item['source_file']).read_text(), 'Нет основания требования')
        require(item.get('kind') in {'result', 'condition'}, 'Требование не разделено на результат или условие')
        require(isinstance(item.get('after', []), list) and isinstance(item.get('each', False), bool), 'Неверная граница результата')
        require(item['kind'] == 'result' or not item.get('after') and not item.get('each'), 'Условие не задаёт этап или повторение')
        if packet['element']['kind'] == 'Задача' and item['kind'] == 'result':
            state = item.get('state')
            require(isinstance(state, dict) and set(state) == {'object', 'property', 'value'} and
                    all(isinstance(v, str) and v.strip() for v in state.values()), 'Результату Хода нужно одно наблюдаемое свойство объекта')
    return requirements


def baseline_lock(root, packet_name):
    packet, inputs = packet_inputs(root, packet_name)
    eid = str(uuid.UUID(packet['element']['id']))
    name = 'baselines/' + eid + '.json'
    return name, inputs


def bind(root, packet_name, baseline_name):
    independent_requirements(root, packet_name, baseline_name)
    name, inputs = baseline_lock(root, packet_name)
    lock = {'packet': packet_name, 'inputs': inputs, 'baseline': baseline_name,
            'baseline_sha256': sha(local(root, baseline_name))}
    if local(root, name).exists():
        require(load(local(root, name)) == lock, 'Критерии Операции уже зафиксированы')
    else:
        save(local(root, name), lock)
    return {'bound': True, 'lock': name}


def bound_baseline(root, packet_name):
    name, inputs = baseline_lock(root, packet_name)
    require(local(root, name).exists(), 'До сборки зафиксируй независимые критерии командой bind')
    lock = load(local(root, name))
    require(lock['packet'] == packet_name and lock['inputs'] == inputs and
            sha(local(root, lock['baseline'])) == lock['baseline_sha256'], 'Изменены зафиксированные критерии или входы')
    return name, lock


def verify_receipt(root, name, seen=None):
    seen = set() if seen is None else seen
    require(name not in seen, 'Цикл квитанций')
    receipt = load(local(root, name))
    for file, digest in receipt['files'].items():
        require(sha(local(root, file)) == digest, 'Изменена принятая версия: ' + file)
    for parent in receipt['parents']:
        verify_receipt(root, parent, seen | {name})


def build(root, packet_name, candidate_name, prefix):
    packet, inputs = packet_inputs(root, packet_name)
    lock_name, lock = bound_baseline(root, packet_name)
    if packet.get('receipt'):
        verify_receipt(root, packet['receipt'])
    stage = compile_plan(packet, load(local(root, candidate_name)))
    compiled = prefix + '.json'
    save(local(root, compiled), stage)
    md = local(root, prefix + '.md')
    require(not md.exists(), 'Версия уже существует')
    md.write_text(markdown(stage))
    manifest = {'packet': packet_name, 'candidate': candidate_name, 'compiled': compiled,
                'inputs': inputs, 'files': {name: sha(local(root, name)) for name in [candidate_name, compiled, prefix + '.md']},
                'baseline': lock['baseline'], 'baseline_sha256': lock['baseline_sha256'],
                'parents': [packet['receipt']] if packet.get('receipt') else []}
    manifest['files'][lock_name] = sha(local(root, lock_name))
    save(local(root, prefix + '.manifest.json'), manifest)
    return {'compiled': compiled, 'manifest': prefix + '.manifest.json', 'mechanical_check': 'pass'}


def release(root, manifest_name, baseline_name, review_name, receipt_name):
    manifest = load(local(root, manifest_name))
    for name, digest in dict(manifest['inputs'], **manifest['files']).items():
        require(sha(local(root, name)) == digest, 'Изменены проверяемые данные: ' + name)
    for parent in manifest['parents']:
        verify_receipt(root, parent)
    baseline, review = load(local(root, baseline_name)), load(local(root, review_name))
    _, lock = bound_baseline(root, manifest['packet'])
    require(baseline_name == manifest['baseline'] == lock['baseline'] and
            sha(local(root, baseline_name)) == manifest['baseline_sha256'] == lock['baseline_sha256'], 'Подменены критерии между версиями')
    require(review['baseline_sha256'] == sha(local(root, baseline_name)), 'Изменено независимое основание проверки')
    require(review['candidate_sha256'] == manifest['files'][manifest['candidate']], 'Проверена другая версия')
    requirements = independent_requirements(root, manifest['packet'], baseline_name)
    coverage = review['coverage']
    require(len(coverage) == len(requirements) and {c['requirement'] for c in coverage} == set(requirements), 'Не все требования проверены')
    stage = load(local(root, manifest['compiled']))
    plan = load(local(root, manifest['candidate']))
    packet = load(local(root, manifest['packet']))
    require(compile_plan(packet, plan) == stage, 'Сборка не соответствует предметному плану')
    known = {w['key'] for w in plan['work']} | {c['key'] for c in plan['children']}
    if stage.get('awaiting_clarification'):
        known.add('system:clarify')
    expansions = {'expand:' + d['after'] for d in plan['deferred']}
    chain = {n['result']: n for n in result_chain(plan)}
    mapped, occupied = {}, set()
    require(not chain or any(r['kind'] == 'result' for r in requirements.values()), 'Проверка не выделила самостоятельных результатов')
    for c in coverage:
        require(isinstance(c['items'], list) and c['items'] and len(c['items']) == len(set(c['items'])), 'Пустое покрытие или повтор ссылки')
        requirement = requirements[c['requirement']]
        if requirement['kind'] == 'result':
            require(len(c['items']) == 1 and c['items'][0] in chain, 'Результат должен ссылаться на один явный узел цепочки')
            ref = c['items'][0]
            require(ref not in occupied, 'Два независимых результата проверки склеены в одном узле')
            require(bool(requirement.get('each')) == ('each' in chain[ref]), 'Потеряно или выдумано повторение по объектам')
            mapped[c['requirement']], occupied = ref, occupied | {ref}
        else:
            require(set(c['items']) <= known | expansions | set(chain), 'Требование ссылается на отсутствующую работу')
    def ancestors(ref, visiting=None):
        visiting = set() if visiting is None else visiting
        require(ref not in visiting, 'Цикл независимых результатов')
        return {p for before in chain[ref]['after'] for p in {before} | ancestors(before, visiting | {ref})}
    for key, ref in mapped.items():
        after = requirements[key].get('after', [])
        require(len(after) == len(set(after)) and all(p in mapped and mapped[p] in ancestors(ref) for p in after), 'Нарушен порядок независимых результатов')
    require(review['verdict'] == 'accept' and review['errors'] == [], 'Проверяющий вернул постановку: ' + json.dumps(review['errors'], ensure_ascii=False))
    files = dict(manifest['inputs'], **manifest['files'])
    for name in (manifest_name, baseline_name, review_name):
        files[name] = sha(local(root, name))
    receipt = {'element': stage['element']['id'], 'operation': stage['operation']['id'], 'files': files, 'parents': manifest['parents'], 'compiled': manifest['compiled']}
    save(local(root, receipt_name), receipt)
    return {'accepted': True, 'receipt': receipt_name, 'compiled': manifest['compiled']}


def child_packet(root, receipt_name, child_key, output):
    verify_receipt(root, receipt_name)
    receipt = load(local(root, receipt_name))
    stage = load(local(root, receipt['compiled']))
    matches = [x for x in stage['children'] if x['key'] == child_key]
    require(len(matches) == 1, 'Ребёнок не найден')
    packet = dict(matches[0], receipt=receipt_name)
    save(local(root, output), packet)
    return {'packet': output}


if __name__ == '__main__':
    try:
        action, root_name, *args = sys.argv[1:]
        root = Path(root_name).resolve()
        funcs = {'bind': bind, 'build': build, 'release': release, 'child': child_packet}
        result = funcs[action](root, *args)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OSError) as exc:
        result = {'accepted': False, 'error': str(exc)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get('accepted', True) else 1)
