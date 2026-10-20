// ABOUTME: Человекочитаемый обзор сохранённого плана; не меняет план и решения.
const text = value => typeof value === 'string' ? value.trim() : '';
const readable = value => text(value).replace(/Игроком/gu, 'тобой').replace(/Игрока/gu, 'тебя');
const fieldsOf = element => element.fields?.draft ?? element.fields ?? {};
const management = new Set(['plan', 'start', 'accept', 'finish', 'confirm', 'review']);

function roles(fields) {
  // Explicit author text, not an inference from a title, result, or a shared start Operation.
  return text(fields.scope).split(/\n/).map(line => line.match(/^\s*(Я|Ты):\s*(.+)$/u))
    .filter(Boolean).map(([, actor, work]) => ({ actor, work: readable(work) })).filter(item => item.work);
}
function ordered(items, previous = item => item.previousId) {
  const pending = [...items], result = [];
  while (pending.length) {
    const index = pending.findIndex(item => !pending.some(other => other.id === previous(item)));
    // A broken relation must not fabricate an execution order.
    if (index < 0) return items;
    result.push(...pending.splice(index, 1));
  }
  return result;
}
function workMoves(graph, element) {
  const current = new Set((graph.resources ?? []).filter(resource => resource.metadata?.plan_revision_id === element.revision)
    .map(resource => resource.metadata?.receipt?.operation).filter(Boolean));
  return ordered((graph.moves ?? []).filter(item => item.targetId === element.id && item.status !== 'cancelled'
    && !current.has(item.id) && !management.has(item.purpose) && !['confirm'].includes(item.fields?.planning?.decision)
    && (!element.fields?.planning || current.has(item.id) || item.fields?.planning?.revision_id === element.revision)));
}
function actorOf(move) {
  const actor = move.executor ?? move.fields?.actor;
  return actor === 'agent' ? 'Я' : ['human', 'player'].includes(actor) ? 'Ты' : null;
}
function savedRoles(graph, element) {
  const explicit = roles(fieldsOf(element));
  if (explicit.length) return explicit.map(item => `${item.actor}: ${item.work}`);
  return workMoves(graph, element).filter(item => actorOf(item)).map(item =>
    `${actorOf(item)}: ${readable(item.title)}${item.status === 'succeeded' ? ' — готово' : ''}`).filter(line => !line.endsWith(': '));
}
function childrenOf(graph, element) {
  const children = (graph.elements ?? []).filter(child => child.parentId === element.id && child.status !== 'cancelled');
  const chain = element.fields?.planning?.chain ?? [];
  const rank = new Map(chain.map((entry, index) => [entry.by, index]));
  return children.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
function childSummary(child) {
  const fields = fieldsOf(child);
  const scope = text(fields.scope).split(/\n/).filter(line => !/^\s*(Я|Ты):/u.test(line)).join(' ')
    .replace(/^Известная практическая работа:\s*/u, '');
  // Scope holds known boundaries/work; do not infer a role from its wording.
  const summary = readable(scope) || readable(fields.summary || child.description || fields.expected_result);
  return summary ? summary[0].toLocaleUpperCase('ru') + summary.slice(1) : '';
}

export function confirmationText(graph, move, target, inputs = move.input ?? []) {
  const decision = move.fields?.planning?.decision;
  if (!move.fields?.planning) return undefined;
  if (decision === 'clarify') {
    return [target.title, 'Нужно уточнить поручение:', String(move.fields.question ?? move.fields.expected_answer ?? move.instructions ?? move.title),
      'Ответь обычным сообщением.'].join('\n\n');
  }
  if (decision === 'final') {
    const resources = (graph.resources ?? []).filter(resource => inputs.includes(resource.id) && !resource.metadata?.stage);
    if (!resources.length) return null;
    return [target.title, 'Готовый результат', ...resources.map(resource => `${resource.title}\n${resource.content}`),
      'Принимаешь этот результат? Замечания или отмену напиши сообщением.'].join('\n\n');
  }
  if (decision !== 'confirm') return undefined;
  const fields = fieldsOf(target), children = childrenOf(graph, target), blocks = [target.title];
  const result = readable(fields.expected_result || fields.summary || target.description);
  if (result && result !== target.title) blocks.push(`Результат: ${result}`);
  const constraints = readable(fields.constraints);
  if (constraints) blocks.push('Условия:\n' + constraints.split(/\n+|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u).map(item => `• ${item}`).join('\n'));
  let unresolved = false;
  if (children.length) {
    const overview = (child, label) => {
      const lines = [`${label}. ${child.title}`], knownRoles = savedRoles(graph, child), summary = childSummary(child);
      if (summary && summary !== child.title) lines.push(summary);
      lines.push(...knownRoles);
      if (!knownRoles.length && !workMoves(graph, child).length) unresolved = true;
      return lines.join('\n\n');
    };
    const plan = children.flatMap((child, index) => [overview(child, `${index + 1}`),
      ...(target.kind === 'quest' ? childrenOf(graph, child).map((nested, nestedIndex) =>
        overview(nested, `${index + 1}.${nestedIndex + 1}`)) : [])]);
    blocks.push('План', ...plan);
  } else {
    const work = workMoves(graph, target);
    if (work.length) blocks.push('План', ...work.map((item, index) => {
      const actor = actorOf(item), title = readable(item.title);
      return `${index + 1}. ${actor ? `${actor}: ` : ''}${title}${item.status === 'succeeded' ? ' — готово' : ''}`;
    }));
    else {
      const explicit = savedRoles(graph, target);
      if (explicit.length) blocks.push('План', ...explicit);
      else unresolved = true;
    }
  }
  if (children.length && unresolved) blocks.push('Подробный порядок каждой задачи согласуем перед её началом.');
  blocks.push('Принять этот план? Если хочешь изменить или отменить его, напиши сообщением.');
  return blocks.join('\n\n');
}
