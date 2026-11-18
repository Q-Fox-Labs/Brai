# ABOUTME: Различает пояснения и итог событий Codex app-server в личном чате.
# ABOUTME: Сохраняет неполный текст при сбое и не считает его завершённым ответом.
"""Учёт фаз событий одного хода Codex без сетевых операций."""


class CodexProgress:
    """Собрать события одного хода до подтверждения результата."""

    def __init__(self):
        self.reset()

    def reset(self):
        """Начать новый ход без остатков предыдущего."""
        self.items = {}
        self.sequence = []
        self.current = None
        self.complete = False
        self.status = None
        self.incomplete_snapshot = False
        self.latest_tool = -1
        self.order = 0

    def _entry(self, ident):
        ident = str(ident or self.current or 'unidentified')
        if ident not in self.items:
            self.items[ident] = {'phase': None, 'deltas': [], 'text': None, 'complete': False,
                                 'order': self.order, 'snapshot_terminal': True, 'in_full_snapshot': False,
                                 'conflict': False}
            self.sequence.append(ident)
        self.current = ident
        return self.items[ident]

    def _message(self, item, *, completed):
        entry = self._entry(item.get('id'))
        phase = item.get('phase')
        if isinstance(phase, str) and phase.strip():
            entry['phase'] = phase.strip().lower()
        if completed:
            text = item.get('text')
            if (not isinstance(text, str) or not text) and entry['deltas']:
                return
            entry['text'] = text if isinstance(text, str) else ''
            entry['text'] = entry['text'].replace('<turn_aborted>', '').replace('<turn_aborted/>', '')
            delta_text = ''.join(entry['deltas']).replace('<turn_aborted>', '').replace('<turn_aborted/>', '')
            entry['conflict'] = bool(delta_text and not entry['text'].startswith(delta_text))
            if not entry['complete']:
                entry['order'] = self.order
            entry['complete'] = True

    def observe(self, note):
        """Учесть событие; завершённый снимок может содержать пропущенные items."""
        if not isinstance(note, dict):
            return
        self.order += 1
        method = note.get('method')
        params = note.get('params') if isinstance(note.get('params'), dict) else {}
        item = params.get('item')
        if method in ('item/started', 'item/completed') and isinstance(item, dict):
            if item.get('type') == 'agentMessage':
                self._message(item, completed=method == 'item/completed')
            elif item.get('type'):
                self.latest_tool = self.order
        elif method == 'item/agentMessage/delta':
            value = params.get('delta')
            if isinstance(value, str) and value:
                self._entry(params.get('itemId') or params.get('item_id'))['deltas'].append(value)
        elif method == 'turn/completed':
            turn = params.get('turn') if isinstance(params.get('turn'), dict) else {}
            self.complete = True
            self.status = turn.get('status')
            self.incomplete_snapshot = turn.get('itemsView', 'full') != 'full'
            items = (turn.get('items') if turn.get('itemsView', 'full') == 'full'
                     and isinstance(turn.get('items'), list) else [])
            last_tool = max((index for index, item in enumerate(items)
                             if isinstance(item, dict) and item.get('type') and item.get('type') != 'agentMessage'), default=-1)
            for index, item in enumerate(items):
                if isinstance(item, dict) and item.get('type') == 'agentMessage':
                    self._message(item, completed=True)
                    entry = self._entry(item.get('id'))
                    entry['in_full_snapshot'] = True
                    entry['snapshot_terminal'] = index > last_tool

    def phase(self, item):
        """Вернуть известную фазу даже когда она была только в начале item."""
        phase = item.get('phase')
        if isinstance(phase, str) and phase.strip():
            return phase.strip().lower()
        return self.items.get(str(item.get('id') or self.current or 'unidentified'), {}).get('phase')

    @staticmethod
    def _merge(parts):
        result = ''
        for part in parts:
            if not isinstance(part, str) or not part:
                continue
            if part.startswith(result):
                result = part
            elif not result.startswith(part):
                result = result + '\n\n' + part if result else part
        return result

    def _terminal_position(self, item):
        if item['in_full_snapshot']:
            return item['snapshot_terminal']
        return item['order'] > self.latest_tool

    def result(self, success):
        """Вернуть подтверждённый итог либо неполный текст после сбоя."""
        entries = [self.items[ident] for ident in self.sequence]
        partials = [item['text'] for item in entries if item['complete'] and item['phase'] == 'partial_answer']
        finals = [item['text'] for ident, item in self.items.items() if ident == self.current
                  and item['complete'] and item['phase'] == 'final_answer'
                  and self._terminal_position(item)]
        unknown = [item['text'] for ident, item in self.items.items() if ident == self.current
                   and item['complete'] and item['phase'] not in
                   ('commentary', 'partial_answer', 'final_answer', 'analysis') and self._terminal_position(item)]
        if success:
            if finals:
                return self._merge([*partials, finals[-1]])
            return self._merge([*partials, unknown[-1] if unknown else ''])
        parts = []
        for item in entries:
            if item['phase'] in ('commentary', 'analysis'):
                continue
            if item['complete'] and (item['phase'] == 'partial_answer' or self._terminal_position(item)):
                parts.append(item['text'])
            if not item['complete'] or item['conflict']:
                parts.append(''.join(item['deltas']).replace('<turn_aborted>', '').replace('<turn_aborted/>', ''))
        return self._merge(parts)

    def reconcile(self, turn):
        """Сверить результат с завершением хода и вернуть незавершённый текст при сбое."""
        success = self.complete and self.status == 'completed' and not turn.interrupted and not turn.error
        terminal = any(ident == self.current and item['complete']
                       and item['phase'] not in ('commentary', 'partial_answer', 'analysis')
                       and self._terminal_position(item)
                       for ident, item in self.items.items())
        unfinished = any(item['deltas'] and (not item['complete'] or item['conflict'])
                         and item['phase'] not in ('commentary', 'analysis')
                         for item in self.items.values())
        if success and unfinished:
            turn.error = 'Codex app-server не подтвердил полный текст ответа'
            success = False
        if success and not terminal and (self.items or self.latest_tool >= 0 or self.incomplete_snapshot):
            turn.error = 'Codex app-server не подтвердил завершение ответа'
            success = False
        if not success:
            turn.interrupted = True
            turn.error = turn.error or 'Codex app-server не подтвердил завершение ответа'
        text = self.result(success)
        turn.final_text = text
        if success and text:
            # Снимок turn/completed может содержать итог без отдельного item/completed.
            projected = getattr(turn, 'projected_messages', None)
            if isinstance(projected, list):
                completed = [item['text'] for item in self.items.values() if item['complete']
                             and item['phase'] in ('final_answer', None)]
                if completed and not any(row.get('role') == 'assistant' and row.get('content') == completed[-1]
                                         for row in projected if isinstance(row, dict)):
                    projected.append({'role': 'assistant', 'content': completed[-1]})
        return '' if success else text
