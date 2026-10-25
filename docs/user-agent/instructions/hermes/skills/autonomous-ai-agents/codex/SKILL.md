---
name: codex
description: "Delegate coding to OpenAI Codex CLI (features, PRs)."
version: 1.0.1
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Coding-Agent, Codex, OpenAI, Code-Review, Refactoring]
    related_skills: [claude-code, hermes-agent]
---

# Codex CLI

Для разработки, рефакторинга, PR-review и пакетных исправлений через Hermes terminal. Нужны установленный Codex, авторизация API/OAuth и git-репозиторий. Отсутствие OPENAI_API_KEY не доказывает отсутствие OAuth: Hermes использует свой auth.json, standalone CLI — ~/.codex/auth.json.

Используй PTY, `codex exec` для разового задания, `--sandbox workspace-write` для обычной разработки. `--full-auto` устарел; режимы без sandbox/подтверждений имеют отдельные последствия. Не меняй approval_policy на never ради auto-review. Запуск/проверки Codex не заменяют проверки Hermes terminal.

| Когда читать перед действием | Руководство |
|---|---|
| Запуск, авторизация, sandbox/auto-review, ошибка bubblewrap в gateway | [Выполнение](references/guide-execution.md) |
| Долгая фоновая работа, poll/log/input/kill | [Фон](references/guide-background.md) |
| Проверка PR или пакетные review | [Review](references/guide-review.md) |
| Параллельные исправления, worktrees, push/PR, очистка | [Worktrees](references/guide-worktrees.md) |

Ограничивай задачу и workdir, сохраняй чужие изменения. Фоновым процессам дай завершиться, контролируй poll/log; параллельные Codex-процессы допустимы для согласованного пакетного задания. Примеры команд в справочниках не авторизуют несвязанные действия.
