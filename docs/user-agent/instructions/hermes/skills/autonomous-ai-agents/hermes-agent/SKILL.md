---
name: hermes-agent
description: "Use, configure, theme, extend, and orchestrate Hermes Agent."
version: 3.2.0
author: Hermes Agent + Teknium
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes, setup, configuration, multi-agent, spawning, cli, gateway, bots, bot-mode, features, themes, skins, desktop-plugins, tui-widgets, petdex, development]
    homepage: https://github.com/NousResearch/hermes-agent
    related_skills: [claude-code, codex, opencode]
---

# Hermes Agent

Загружай для настройки, диагностики, разработки Hermes или выбора его CLI/Telegram/desktop/web/TUI/MCP-возможностей. Текущая установка и `--help` важнее исторических примеров; не запускай установку только потому, что прочитал навык.

Настройки меняй через `hermes config set`, не ручной YAML; в `.env` только учётные данные, поведение — в `config.yaml`; значения секретов храни по SECRETS.md. В коде пути профиля получай через `get_hermes_home()`, в сессии — HERMES_HOME. Не меняй прошлый контекст, системный промпт или набор инструментов в середине разговора, кроме штатного сжатия; сохраняй чередование ролей сообщений. До работы читай подходящие справочники, а не весь каталог.

| Задача | Справочник |
|---|---|
| Первичная проверка установки, пути, настройки/безопасность | [Основы](references/guide-operating.md) |
| Дополнительные Hermes-процессы, PTY/tmux, координация, resume | [Процессы](references/guide-instances.md) |
| Выбор поверхности: CLI, Telegram, desktop, web, proxy | [Поверхности](references/guide-surfaces.md) |
| Команды, usage/лимиты, профили, PM, credentials | [CLI](references/cli-reference.md) |
| config.yaml, env, инструменты, voice/STT/TTS | [Настройки](references/configuration.md) |
| Провайдер, OAuth, модели, fallback, приём API-ключа | [Модели и доступы](references/providers-and-models.md) |
| Telegram: подключение, команды, подтверждения, Mini Apps | [Операции](references/telegram-operations.md) |
| Русское меню Telegram | [Меню](references/telegram-menu-localization.md) |
| Нативный MCP, сервера, credentials и profile scope | [MCP](references/native-mcp.md) |
| Desktop-плагины и SDK | [Desktop](references/desktop-plugins.md) |
| TUI-виджеты | [Widgets](references/tui-widgets.md) |
| Темы интерфейса | [Темы](references/themes.md) |
| Petdex | [Petdex](references/petdex.md) |
| Cron, фоновые очереди, subagents | [Фон](references/background-systems.md) |
| Нехватка слотов delegate_task | [Диагностика](references/delegate-task-concurrency-diagnosis.md) |
| Webhooks | [Webhooks](references/webhooks.md) |
| OAuth/портал для стороннего приложения | [Портал](references/portal-auth-for-third-party-apps.md) |
| AGENTS/SOUL/project context | [Контекст](references/project-context-files.md) |
| Разработка самого Hermes | [Разработка](references/contributor-guide.md) |
| Windows | [Windows](references/windows-quirks.md) |
| Ошибка, обновление, восстановление | [Диагностика](references/troubleshooting.md) |
| Slash-команды | [Slash](references/slash-commands.md) |
| Безопасность/приватность | [Политика](references/security-privacy.md) |

Перед применением команд сверяй профиль, backend, версию и авторизацию. Проверка установки и пользовательские настройки описаны в guide-operating.md; при настройке/изменении Hermes прочитай его обязательно.
