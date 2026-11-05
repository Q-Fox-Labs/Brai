# Навыки пользовательского агента

Тексты навыков и справочники хранятся как документация и не входят во входы сборки или payload Hermes. Самостоятельные текстовые изменения проходят обычным порядком документации. Скрипты остаются в [коде расширений](../../services/hermes/extensions/README.md) и проходят выпуск кода.

## Каталог

- [Задачи Brai](instructions/skills/brai-task-workflows/SKILL.md).
- [Codex](instructions/hermes/skills/autonomous-ai-agents/codex/SKILL.md).
- [Hermes](instructions/hermes/skills/autonomous-ai-agents/hermes-agent/SKILL.md).
- [Арт-директор](instructions/hermes/skills/creative/art-director/SKILL.md).
- [Обратная связь](instructions/hermes/skills/creative/reply-feedback-learning/SKILL.md).
- [YouTube](instructions/hermes/skills/media/youtube-content/SKILL.md).
- [MemOS](instructions/hermes/skills/note-taking/memos-memory/SKILL.md).
- [Локальный голос](instructions/hermes/skills/silero-local-voice/SKILL.md).
- [Instagram](instructions/hermes/skills/social-media/instaloader/SKILL.md).
- [Проверка кода](instructions/hermes/skills/software-development/requesting-code-review/SKILL.md).

## Установка текстов

Оператор передаёт tools/skill_docs.py каталог Git, полный SHA коммита документации и профиль. Сначала выполняет plan, затем apply и отдельный verify. Установщик читает только UTF-8 файлы .md и .txt двух каталогов навыков. Он обновляет штатные каталоги профиля и отдельную квитанцию docs/skill-documentation.json без сборки, модели и перезапуска служб.

Первичный adopt-existing сохраняет отличающиеся установленные тексты как локальные варианты. Неизвестные последующие правки останавливают обновление. Исчезнувшие из нового каталога тексты, скрипты и личные дополнения не удаляются. Прежние байты изменённых текстов сохраняются в backups/; ошибка текущего применения возвращает собственные записи.

Новая сессия читает установленный навык через skill_view; открытая может хранить прежний текст в контексте. Commit документации сам по себе не обновляет установленную копию. Базовые политики и контекст остаются в проверенной поставке адаптера.
