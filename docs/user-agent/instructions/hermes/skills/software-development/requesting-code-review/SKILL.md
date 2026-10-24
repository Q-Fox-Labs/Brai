---
name: requesting-code-review
description: "Pre-commit review: security scan, quality gates, auto-fix."
version: 2.1.0
author: Hermes Agent (adapted from obra/superpowers + MorAlekss)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [code-review, security, verification, quality, pre-commit, auto-fix]
    related_skills: [subagent-driven-development, test-driven-development, github]
---

# Проверка кода перед коммитом

Для собственных изменений перед commit/push/merge, после реализации или 2+ правок кода. Документацию, чистую конфигурацию и явно разрешённое владельцем «skip verification» исключи. Чужие GitHub PR проверяет навык github.

| Этап | Читать перед выполнением |
|---|---|
| Diff, untracked, статический поиск, baseline/tests/lint | [Основные проверки](references/guide-checks.md) |
| Интерактивное независимое ревью, JSON-вердикт | [Reviewer](references/guide-reviewer.md) |
| Оценка, auto-fix до двух циклов, commit | [Решение](references/guide-verdict.md) |
| Конкретные небезопасные Python/JS-паттерны | [Примеры](references/guide-patterns.md) |

Проверяй staged/working-tree diff, новые файлы и относящиеся исходники вне Git; большой diff разбивай по файлам. Сохраняй чужие изменения. Новые регрессии блокируют, существующие failures учитывай как baseline. Недоступный lint/test-framework отличай от проваленной проверки.

Интерактивный reviewer получает код, новые файлы, scan, критерии, callers/state transitions; не рассказ автора об успехе. Непарсируемый вердикт или воспроизведённая security/logic ошибка блокируют независимо от зелёных старых тестов; suggestions не блокируют. Для очередей/многопользовательской памяти проверь ownership, interleavings, transactional claims/version checks, awaits/acks/echoes и starvation.

One-shot/benchmark: не вызывай reviewer/третьего fix-агента, проверь diff сам и запусти тесты. Интерактивно delegate_task вызывается напрямую, не из execute_code. Auto-fix исправляет только findings, максимум два цикла; затем сообщи остаток. Коммить только согласованный объём после проверок; [verified] означает реальное независимое одобрение.
