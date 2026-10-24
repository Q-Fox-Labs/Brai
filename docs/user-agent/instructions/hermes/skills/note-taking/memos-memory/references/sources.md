# Источники и обновление

Прочитана официальная документация MemTensor/MemOS: HTML через браузер/HTTP и Markdown по официальным адресам. Прочитанные локальные ответы сохранены в рабочем scratch, но канонические источники — страницы ниже. Документация SDK/Cloud и OpenAPI установки могут различаться; для допустимых полей и фактических функций приоритет у живой схемы/установленного кода.

## Официальные источники
- Индекс: https://memos-docs.openmem.net/llms.txt — начать с него при изменённых ссылках; полный корпус /llms-full.txt, Markdown страницы path.md.
- Обзор: https://memos-docs.openmem.net/open_source/home/overview/
- Архитектура: https://memos-docs.openmem.net/open_source/home/architecture
- MemCube и Views: https://memos-docs.openmem.net/open_source/modules/mem_cube
- MemReader и fast/fine: https://memos-docs.openmem.net/open_source/modules/mem_reader.md
- Scheduler и очереди: https://memos-docs.openmem.net/open_source/modules/mem_scheduler.md
- Коррекции: https://memos-docs.openmem.net/open_source/modules/mem_feedback.md
- Структура текста/графа: https://memos-docs.openmem.net/open_source/modules/memories/tree_textual_memory.md
- KV-cache: https://memos-docs.openmem.net/open_source/modules/memories/kv_cache_memory
- Parametric (Coming Soon): https://memos-docs.openmem.net/open_source/modules/memories/parametric_memory
- REST server: https://memos-docs.openmem.net/open_source/getting_started/rest_api_server
- Облачная концепция recall, НЕ контракт локального API: https://memos-docs.openmem.net/memos_cloud/introduction/mem_recall.md
- Облачная концепция lifecycle, НЕ локальный enum статуса: https://memos-docs.openmem.net/memos_cloud/introduction/mem_lifecycle.md
- Hermes provider lifecycle: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
- Официальный код: https://github.com/MemTensor/MemOS

## Локальная истина
${MEMOS_API_URL}/openapi.json и /docs; ${MEMOS_SOURCE}/pyproject.toml, src/memos/api/routers/server_router.py, src/memos/api/product_models.py, src/memos/api/handlers/, examples/api/server_router_api.py. Не запускать example целиком ради изучения: он выполняет реальные POST-записи.

## Обновление скилла
1. Перечитай официальный индекс и относящуюся к изменению страницу, затем живую схему.
2. Сравни версию и конкретный контракт; не переноси cloud SDK поля в /product REST автоматически.
3. Обнови соответствующий справочник, а в SKILL.md — только общие правила/возможности, изменившиеся по существу.
4. Отдели documented, configured, tested. Для подтверждения не изменяй production память без запросов; используй read-only или согласованную тестовую область.
5. Сохраняй узкий trigger: обсуждение/администрирование/диагностика памяти. Не добавляй обязательное чтение в обычный фоновый workflow.
