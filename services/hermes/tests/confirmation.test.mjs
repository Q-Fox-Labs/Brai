// ABOUTME: Проверяет предметный текст Telegram подтверждения без сети и runtime состояния.
// ABOUTME: Убеждается, что renderer использует только текущую ревизию и реальные данные графа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationText } from '../confirmation.mjs';

const revision = 'revision-current';
const otherRevision = 'revision-old';
const target = (kind, fields = {}) => ({ id: 'element-1', kind, title: 'Проверить фотоаппарат',
  description: 'Сохранённое описание результата.', revision, fields });
const move = (id, purpose, title, fields = {}, extra = {}) => ({ id, targetId: 'element-1',
  ownerId: 'element-1', purpose, title, fields: { planning: { revision_id: revision }, ...fields }, ...extra });

test('Task confirmation shows current subject work and constraints, omitting lifecycle boundaries', () => {
  const task = target('task', { expected_result: 'Проверенный список покупок.',
    constraints: 'Не покупать новое. Не выдумывать дополнительные шаги. Не превышать 4 000 ₽; до пятницы; в мастерской.',
    planning: {} });
  const graph = { elements: [task], resources: [], moves: [
    move('old-work', 'work', 'Старая проверка', {}, { fields: { planning: { revision_id: otherRevision } } }),
    move('plan', 'plan', 'Начать составлять план', {}, { instructions: 'Внутренняя политика сервиса: выполнять только в закрытой среде.' }),
    move('confirm', 'confirm', 'Подтвердить план'),
    move('work-1', 'work', 'Проверить гарантийный чек', { actor: 'agent' }, { kind: 'operation' }),
    move('work-2', 'work', 'Сверить срок и адрес', { actor: 'player' }, { kind: 'action' }),
    move('repeat', 'expand-repeat', 'Раскрыть повторную проверку', { actor: 'agent', repeat_over: 'appointments' }),
    move('deferred', 'expand', 'Поставить неизвестное продолжение', { actor: 'agent' }),
    move('clarify', 'clarify', 'Уточнить поручение', { actor: 'player' }, { fields: { planning: { revision_id: revision, decision: 'clarify' } } }),
    move('accept', 'accept', 'Служебная граница приёмки'),
    move('finish', 'finish', 'Служебное завершение'),
    move('review', 'review', 'Служебная проверка'),
  ] };
  const text = confirmationText(graph, move('decision', 'confirm', 'Рассмотреть постановку',
    { planning: { revision_id: revision, decision: 'confirm' } }), task);
  for (const phrase of ['Проверенный список покупок.', 'Не покупать новое', '4 000 ₽', 'до пятницы',
    'в мастерской', 'Не выдумывать дополнительные шаги', 'Проверить гарантийный чек', 'Сверить срок и адрес', 'Раскрыть повторную проверку',
    'Поставить неизвестное продолжение', 'Уточнить поручение']) assert.ok(text.includes(phrase), phrase);
  for (const phrase of ['Старая проверка', 'Начать составлять план', 'Подтвердить план',
    'Служебная граница приёмки', 'Служебное завершение', 'Служебная проверка',
    'Внутренняя политика сервиса', 'Casio']) assert.ok(!text.includes(phrase), phrase);
});

test('Goal and Quest confirmations number saved children and compactly include known nested Tasks', () => {
  const goal = target('goal', { summary: 'Собрать документы без потери оригиналов.' });
  const goalChildren = [
    { id: 'task-a', parentId: goal.id, kind: 'task', title: 'Сверить договор', description: 'Проверить даты и подписи.' },
    { id: 'task-b', parentId: goal.id, kind: 'task', title: 'Собрать приложения', description: 'Сохранить сканы приложений.' },
  ];
  const graph = { elements: [goal, ...goalChildren], resources: [], moves: [] };
  const goalText = confirmationText(graph, move('goal-confirm', 'confirm', 'Рассмотреть Цель',
    { planning: { revision_id: revision, decision: 'confirm' } }), goal);
  assert.ok(goalText.includes('Собрать документы без потери оригиналов.'));
  assert.match(goalText, /1\.[\s\S]*Сверить договор[\s\S]*2\.[\s\S]*Собрать приложения/);
  assert.ok(goalText.includes('Проверить даты и подписи.'));
  assert.ok(goalText.includes('Сохранить сканы приложений.'));

  const quest = target('quest', { summary: 'Подготовить переезд без потери важных вещей.' });
  const questChildren = [
    { id: 'goal-home', parentId: quest.id, kind: 'goal', title: 'Подготовить жильё', description: 'Ключи и коммунальные вопросы.' },
    { id: 'goal-move', parentId: quest.id, kind: 'goal', title: 'Перевезти вещи', description: 'Вещи доставлены целыми.' },
    { id: 'task-nested', parentId: 'goal-move', kind: 'task', title: 'Заказать коробки', description: 'Подобрать подходящий размер.', fields: { scope: 'Я: сравню размеры коробок.\nТы: выберешь подходящий размер.' } },
    { id: 'task-nested-work', parentId: 'goal-move', kind: 'task', title: 'Проверить упаковку' },
  ];
  const questGraph = { elements: [quest, ...questChildren], resources: [], moves: [move('nested-work', 'work', 'Проверю целостность коробок', { actor: 'agent' }, { targetId: 'task-nested-work' })] };
  const questText = confirmationText(questGraph, move('quest-confirm', 'confirm', 'Рассмотреть Квест',
    { planning: { revision_id: revision, decision: 'confirm' } }), quest);
  assert.ok(questText.includes('Подготовить переезд без потери важных вещей.'));
  assert.match(questText, /1\.[\s\S]*Подготовить жильё[\s\S]*2\.[\s\S]*Перевезти вещи/);
  assert.ok(questText.includes('2.1. Заказать коробки'));
  assert.ok(questText.includes('Я: сравню размеры коробок.'));
  assert.ok(questText.includes('Ты: выберешь подходящий размер.'));
  assert.ok(questText.includes('Я: Проверю целостность коробок'));
  assert.ok(questText.includes('Ключи и коммунальные вопросы.'));
});

test('Actor labels require explicit actor facts; draft children use the neutral fallback', () => {
  const task = target('task', { expected_result: 'Проверенный ответ.' });
  const graph = { elements: [task], resources: [], moves: [
    move('agent', 'work', 'Сверить известные данные', { actor: 'agent' }),
    move('human', 'work', 'Проверить реальное наличие', { actor: 'player' }),
    move('unknown', 'work', 'Принять окончательное решение'),
  ] };
  const text = confirmationText(graph, move('confirm', 'confirm', 'Рассмотреть постановку',
    { planning: { revision_id: revision, decision: 'confirm' } }), task);
  assert.ok(text.includes('Я: Сверить известные данные'));
  assert.ok(text.includes('Ты: Проверить реальное наличие'));
  assert.ok(text.includes('Принять окончательное решение'));
  assert.ok(!text.includes('Я: Принять окончательное решение'));
  assert.ok(!text.includes('Ты: Принять окончательное решение'));

  const contextTask = target('task', { scope: 'Я: Подготовить черновик.\nТы: Проверить условия.',
    context: 'Я: Это факты, не исполнитель.\nТы: И это тоже не исполнитель.' });
  const contextText = confirmationText({ elements: [contextTask], resources: [], moves: [] },
    move('context-confirm', 'confirm', 'Рассмотреть постановку',
      { planning: { revision_id: revision, decision: 'confirm' } }), contextTask);
  assert.ok(contextText.includes('Я: Подготовить черновик.'));
  assert.ok(contextText.includes('Ты: Проверить условия.'));
  assert.ok(!contextText.includes('Это факты, не исполнитель'));
  assert.ok(!contextText.includes('И это тоже не исполнитель'));

  const draftGoal = target('goal', { draft: { title: 'Уладить бытовые дела', summary: 'Согласованный итог.' } });
  const draftChild = { id: 'draft-task', parentId: draftGoal.id, kind: 'task', title: 'Разобрать бумаги',
    fields: { draft: { scope: 'Известная практическая работа: Разложить оригиналы по папкам.' } } };
  const draftGraph = { elements: [draftGoal, draftChild], moves: [
    move('start', 'start', 'Поставить: Разобрать бумаги', { actor: 'agent' }, { targetId: draftChild.id }),
  ], resources: [] };
  const draftText = confirmationText(draftGraph, move('confirm-draft', 'confirm', 'Рассмотреть Цель',
    { planning: { revision_id: revision, decision: 'confirm' } }), draftGoal);
  assert.ok(draftText.includes('Подробный порядок каждой задачи согласуем перед её началом'));
  assert.ok(draftText.includes('Разложить оригиналы по папкам.'));
  assert.ok(!draftText.includes('Я:'));
  assert.ok(!draftText.includes('Ты:'));
});

test('Final confirmation shows only required actual resources with their full saved bodies', () => {
  const task = target('task', { expected_result: 'Итоговый акт.' });
  const body = 'Акт проверки оборудования.\nПункт 1: питание отключено.\nПункт 2: пломба цела.\nДата: 20 октября.';
  const graph = { elements: [task], moves: [
    move('internal-review', 'review', 'Скрытая внутренняя проверка'),
    move('internal-finish', 'finish', 'Служебное завершение'),
  ], resources: [
    { id: 'required', title: 'Акт проверки', content: body, metadata: { output_key: 'act' } },
    { id: 'context', title: 'Личный контекст', content: 'Не показывать этот текст.' },
  ] };
  const finalMove = move('final', 'work', 'Проверить акт', {
    planning: { revision_id: revision, decision: 'final' },
  }, { input: ['required'], kind: 'action' });
  const text = confirmationText(graph, finalMove, task, ['required']);
  for (const phrase of ['Готовый результат', 'Акт проверки', body, 'Принимаешь этот результат?']) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('Личный контекст'));
  assert.ok(!text.includes('Не показывать этот текст.'));
  assert.ok(!text.includes('Скрытая внутренняя проверка'));
  assert.ok(!text.includes('Служебное завершение'));
});


test('Subject fields preserve every saved condition and work phrase without lexical filtering', () => {
  const phrases = ['Не выдумывать дополнительные шаги.', 'Не повторять выбор подрядчика.', 'Зафиксировать решение комиссии.', 'Подготовить постановку спектакля.'];
  const task = target('task', { expected_result: phrases[2], constraints: phrases.slice(0, 2).join(' '), scope: `Я: ${phrases[3]}` });
  const result = confirmationText({ elements: [task], moves: [] }, { fields: { planning: { decision: 'confirm' } } }, task);
  for (const phrase of phrases) assert.ok(result.includes(phrase), phrase);
});

test('Disclosed child work takes priority over scope role drafts on the same Task', () => {
  const goal = target('goal');
  const child = { id: 'child', parentId: goal.id, kind: 'task', title: 'Проверить бумаги', fields: { scope: 'Я: составлю старый черновик.\nТы: проверишь старый черновик.' } };
  const graph = { elements: [goal, child], resources: [], moves: [move('current-work', 'work', 'Сверю подписи в оригинале', { actor: 'agent' }, { targetId: child.id })] };
  const result = confirmationText(graph, { fields: { planning: { decision: 'confirm' } } }, goal);
  assert.ok(result.includes('Я: Сверю подписи в оригинале'));
  assert.ok(!result.includes('Я: составлю старый черновик'));
  assert.ok(!result.includes('Ты: проверишь старый черновик'));
});
