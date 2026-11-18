# ABOUTME: Делит Telegram MarkdownV2 без потери текста и выделения.
# ABOUTME: Сохраняет границы escape-пар и не выполняет сетевую отправку.
"""Разбиение готового MarkdownV2 с закрытием и открытием форматирования."""
import re

_LINK = re.compile(r'\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)')
_MARKERS = ('||', '__', '*', '_', '~')


def _join_markup(parts):
    """Разделить соседние italic/underline пустой bold-сущностью Telegram."""
    result = ''
    for part in parts:
        if result.endswith('_') and part.startswith('_'):
            result += '**'
        result += part
    return result


def _next_token(text, offset, stack):
    """Вернуть атом разметки и состояние выделений после него."""
    current = stack[-1] if stack else None
    if text[offset] == '\\':
        return text[offset:offset + 2], stack
    if current and current[0] == 'fence':
        if text.startswith('```', offset):
            return '```', stack[:-1]
        return text[offset], stack
    if current and current[0] == 'code':
        return ('`', stack[:-1]) if text[offset] == '`' else (text[offset], stack)
    if text.startswith('```', offset):
        end = text.find('\n', offset + 3)
        if end >= 0:
            opening = text[offset:end + 1]
            return opening, [*stack, ('fence', opening, '```')]
    if text[offset] == '`':
        return '`', [*stack, ('code', '`', '`')]
    if text[offset] == '[':
        match = _LINK.match(text, offset)
        if match:
            return match.group(), stack
    marker = next((mark for mark in _MARKERS if text.startswith(mark, offset)), None)
    if marker:
        if current and current[0] == marker:
            return marker, stack[:-1]
        return marker, [*stack, (marker, marker, marker)]
    return text[offset], stack


def _split(text, max_length, reserve, len_fn):
    """Разбить текст на части с резервом на индикатор и экранирование."""
    result, offset, stack = [], 0, []
    while offset < len(text):
        # Закрытие на самой границе уже выполнено предыдущей частью.
        while stack:
            token, following = _next_token(text, offset, stack)
            if len(following) != len(stack) - 1:
                break
            offset += len(token)
            stack = following
            if offset == len(text):
                return result
        opening = _join_markup(entry[1] for entry in stack)
        body, body_size = [], 0
        safe = None
        line_break = space_break = None
        half = (max_length - len_fn(opening) - reserve) // 2
        while offset < len(text):
            token, following = _next_token(text, offset, stack)
            closing = _join_markup(entry[2] for entry in reversed(following))
            start_separator = 2 if opening.endswith('_') and (body[0] if body else token).startswith('_') else 0
            end_separator = 2 if token.endswith('_') and closing.startswith('_') else 0
            size = len_fn(opening) + body_size + len_fn(token) + len_fn(closing) + reserve + start_separator + end_separator
            if size > max_length:
                break
            before = (offset, list(stack), len(body), body_size)
            body.append(token)
            body_size += len_fn(token)
            offset += len(token)
            # Маркер открытия не оставляем в конце части без содержимого.
            if len(following) <= len(stack):
                safe = (offset, list(following), len(body), body_size)
            elif safe is None:
                safe = before
            if body_size >= half and token == '\n':
                line_break = (offset, list(following), len(body), body_size)
            elif body_size >= half and token == ' ':
                space_break = (offset, list(following), len(body), body_size)
            stack = following
        chosen = line_break or space_break
        if offset < len(text) and chosen:
            offset, stack, count, body_size = chosen
            body = body[:count]
        elif offset < len(text) and body and len(stack) > (len(safe[1]) if safe else 0):
            offset, stack, count, body_size = safe
            body = body[:count]
        if not body:
            raise ValueError('Один элемент разметки не помещается в сообщение Telegram')
        body_text = ''.join(body)
        closing = _join_markup(entry[2] for entry in reversed(stack))
        result.append(_join_markup((opening, body_text, closing)))
    return result


def split_bold(text, max_length, *, truncate, len_fn):
    """Разбить MarkdownV2 по лимиту Telegram, сохраняя текст и разметку.

    Служебные маркеры и номера частей входят в заданный лимит. Исходный
    делитель передаётся для совместимости вызывающего адаптера.
    """
    if len_fn(text) <= max_length:
        return [text]
    reserve = len_fn(' (1/1)') + 2  # Telegram-адаптер экранирует две скобки.
    while True:
        try:
            chunks = _split(text, max_length, reserve, len_fn)
        except ValueError:
            # Длинная ссылка может поместиться только без нумерации частей.
            return _split(text, max_length, 0, len_fn)
        if len(chunks) <= 1:
            return chunks
        required = len_fn(f' ({len(chunks)}/{len(chunks)})') + 2
        if required <= reserve:
            return [f'{chunk} ({index}/{len(chunks)})' for index, chunk in enumerate(chunks, 1)]
        reserve = required
