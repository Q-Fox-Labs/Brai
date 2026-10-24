# Elements: техническое устройство

Сервис владеет элементами, ревизиями, ходами, попытками и ресурсами. Внешняя граница описана в [контракте](CONTRACT.md); транспортные схемы и входы принадлежат этому сервису.

## Реализация и настройка

Приложение находится в src/, миграции — в migrations/, закреплённые правила и сборщик планирования — в planning/. Конфигурацию и owner binding передаёт экземпляр; запуск не заменяет отдельное применение миграций.

Планирование читает точные правила по baseline и проверяет SHA-256. Рабочий пакет передаётся автору и независимому проверяющему; агент не подтверждает решения пользователя.

Нормативный отказ MCP содержит этап и безопасную причину в `diagnostic`; формат и правила исправления закреплены в контракте. Принятые правила сборщика остаются неизменными.

## Проверки

Команды сборки и проверок закреплены в [package.json](package.json) и [component.json](component.json). Интеграционные проверки используют отдельные тестовые входы. Правила планирования относятся к рабочим данным сервиса и не переносятся в правила разработки.

## Связанные материалы

- [CONTRACT.md](CONTRACT.md).
- [planning/element-classification-rules.md](planning/element-classification-rules.md).
- [planning/game-planning-format.md](planning/game-planning-format.md).
- [planning/game-planning-rules.md](planning/game-planning-rules.md).
- [planning/goal-planning-rules.md](planning/goal-planning-rules.md).
- [planning/planning-review-rules.md](planning/planning-review-rules.md).
- [planning/quest-planning-rules.md](planning/quest-planning-rules.md).

Принятые правила planning/ сохраняют исходные байты по baseline. Историческая ссылка AGENTS.md в исходном алгоритме относится к контексту его авторства; она не подключает правила разработки к пользовательскому агенту. Проверка документации сверяет hash этих правил и сохраняет эту ссылку.
