# Инструкции пользовательского агента

SOUL.md — штатная точка входа Hermes. В начале сессии полностью прочитай этот индекс, [BASE.md](BASE.md) и личный ROUTING.md по указанным в SOUL.md установленным путям. Затем загружай только подходящие задаче инструкции. При обрезке дочитай файл до конца.

Устройство источников и пользовательских дополнений — в [ARCHITECTURE.md](ARCHITECTURE.md). Настройки экземпляра, имя и доступность сервисов проверяй в действующем профиле; они не наследуются с текстами продукта.

## Политики

| Читать перед действием | Документ |
| --- | --- |
| Создание или перенос файлов, проекта, базы, бэкап | [DATA_STORAGE.md](policies/DATA_STORAGE.md) |
| Изменение инструкций, промпта, навыка или персональной замены | [INSTRUCTION_CHANGES.md](policies/INSTRUCTION_CHANGES.md) |
| Установка ПО, настройка системы и служб | [SYSTEM_OPERATIONS.md](policies/SYSTEM_OPERATIONS.md) |
| Использование имени или представление от лица владельца | [OWNER_IDENTITY.md](policies/OWNER_IDENTITY.md) |
| Запись, исправление, удаление или передача памяти | [MEMORY_POLICY.md](policies/MEMORY_POLICY.md) |
| Pause/resume памяти, SQL-права или восстановление | [MEMORY_OPERATIONS.md](policies/MEMORY_OPERATIONS.md) |
| Приём и хранение секретов, форма Telegram | [SECRETS.md](policies/SECRETS.md) |
| Разрешения, опасная команда, отказ проверяющей модели | [PERMISSIONS_RU.md](policies/PERMISSIONS_RU.md) |
| Голосовой ответ, смена голоса или голосового режима | [LOCAL_VOICE.md](policies/LOCAL_VOICE.md) |
| Русская справка Hermes | [RUSSIAN_HELP.txt](policies/RUSSIAN_HELP.txt) |

## Навыки

Навыки открывай штатным skill_view; их справочники — по маршрутам навыка. Эти ссылки задают канонический источник текста. Наличие навыка не подтверждает доступность его внешней программы.

- [codex](skills/autonomous-ai-agents/codex/SKILL.md)
- [hermes-agent](skills/autonomous-ai-agents/hermes-agent/SKILL.md)
- [reply-feedback-learning](skills/creative/reply-feedback-learning/SKILL.md)
- [youtube-content](skills/media/youtube-content/SKILL.md)
- [memos-memory](skills/note-taking/memos-memory/SKILL.md)
- [silero-local-voice](skills/silero-local-voice/SKILL.md)
- [instaloader](skills/social-media/instaloader/SKILL.md)
- [requesting-code-review](skills/software-development/requesting-code-review/SKILL.md)

Для настройки и диагностики плагинов используй руководства рядом с их установленным кодом и установленный [навык Hermes](skills/autonomous-ai-agents/hermes-agent/SKILL.md) с его справочниками. Промпт Telegram Business — [здесь](prompts/telegram-reply.md); отправка требует подтверждения владельца.

Документы установщика и правила разработки не являются инструкциями пользовательского агента. Секреты, память и переписка в этот раздел не переносятся.
