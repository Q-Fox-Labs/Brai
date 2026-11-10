# Матрица инструментов первого этапа ролей

Таблица фиксирует поставляемые имена и разрешения. Фактическое наличие зависит от включённых компонентов и зарегистрированного каталога: разрешение не включает выключенный сервис. Каждая операция сохраняет проверку владельца и области данных. Creator наследует продуктовые права admin, без новых полномочий ОС.

У MCP-имён в native Hermes есть префикс `mcp__brai__`. В столбцах «Да» означает разрешение политики; handler выполняется только после актуальной проверки Auth. Неизвестная роль запрещена. Имя без зарегистрированного handler не исполняется; guest дополнительно ограничен точным списком `tool-policy.json`. При отказе Auth каталог и dispatch не расширяются.

## Продуктовый MCP-каталог

Источники: `catalog.mjs`, `runtime.mjs`, `files/metadata.mjs`, `planning-read.mjs`, `identity/control.mjs` и `tool-policy.json`. `publish_file`/`fetch_file` исключены из remote Control и добавляются личным клиентом ниже.

| Имя | creator | admin | user | guest |
| --- | --- | --- | --- | --- |
| `alerts_get` | Да | Да | Да | Нет |
| `alerts_list` | Да | Да | Да | Нет |
| `alerts_read` | Да | Да | Да | Нет |
| `alerts_read_all` | Да | Да | Да | Нет |
| `alerts_summary` | Да | Да | Да | Нет |
| `dialogues_context_ack` | Да | Да | Да | Да |
| `dialogues_exchange` | Да | Да | Да | Да |
| `files_get` | Да | Да | Да | Да |
| `files_list` | Да | Да | Да | Да |
| `files_prepare` | Да | Да | Да | Да |
| `game_core_element_activate` | Да | Да | Да | Нет |
| `game_core_element_create` | Да | Да | Да | Нет |
| `game_core_element_reclassify` | Да | Да | Да | Нет |
| `game_core_element_revise` | Да | Да | Да | Нет |
| `game_core_graph_get` | Да | Да | Да | Нет |
| `game_core_move_claim` | Да | Да | Да | Нет |
| `game_core_move_complete` | Да | Да | Да | Нет |
| `game_core_move_create` | Да | Да | Да | Нет |
| `game_core_move_fail` | Да | Да | Да | Нет |
| `game_core_move_link` | Да | Да | Да | Нет |
| `game_core_moves_available` | Да | Да | Да | Нет |
| `game_core_planning_apply` | Да | Да | Да | Нет |
| `game_core_planning_bind` | Да | Да | Да | Нет |
| `game_core_planning_build` | Да | Да | Да | Нет |
| `game_core_planning_expand_repeat` | Да | Да | Да | Нет |
| `game_core_planning_packet` | Да | Да | Да | Нет |
| `game_core_planning_packet_read` | Да | Да | Да | Нет |
| `game_core_request_human_action` | Да | Да | Да | Нет |
| `game_core_result_review_skip` | Да | Да | Да | Нет |
| `game_core_structure_create` | Да | Да | Да | Нет |
| `game_core_timeline_get` | Да | Да | Да | Нет |
| `history_categories_list` | Да | Да | Да | Нет |
| `history_get` | Да | Да | Да | Нет |
| `history_list` | Да | Да | Да | Нет |
| `history_type_get` | Да | Да | Да | Нет |
| `history_types_list` | Да | Да | Да | Нет |
| `local_ai_cancel` | Да | Да | Нет | Нет |
| `local_ai_catalog_search` | Да | Да | Да | Нет |
| `local_ai_invoke_embed` | Да | Да | Да | Нет |
| `local_ai_invoke_synthesize` | Да | Да | Да | Нет |
| `local_ai_invoke_transcribe` | Да | Да | Да | Нет |
| `local_ai_models_configure` | Да | Да | Нет | Нет |
| `local_ai_models_get` | Да | Да | Да | Нет |
| `local_ai_models_install` | Да | Да | Нет | Нет |
| `local_ai_models_list` | Да | Да | Да | Нет |
| `local_ai_models_load` | Да | Да | Нет | Нет |
| `local_ai_models_remove` | Да | Да | Нет | Нет |
| `local_ai_models_unload` | Да | Да | Нет | Нет |
| `local_ai_operations_get` | Да | Да | Да | Нет |
| `local_ai_status` | Да | Да | Да | Нет |
| `timer_command_get` | Да | Да | Да | Нет |
| `timer_delete` | Да | Да | Да | Нет |
| `timer_edit` | Да | Да | Да | Нет |
| `timer_history_get` | Да | Да | Да | Нет |
| `timer_snapshot_get` | Да | Да | Да | Нет |
| `timer_start` | Да | Да | Да | Нет |
| `timer_statistics_get` | Да | Да | Да | Нет |
| `timer_stop` | Да | Да | Да | Нет |
| `transcription_models_list` | Да | Да | Да | Нет |
| `transcription_request_cancel` | Да | Да | Да | Нет |
| `transcription_request_get` | Да | Да | Да | Нет |
| `transcription_request_submit` | Да | Да | Да | Нет |
| `transcription_result_get` | Да | Да | Да | Нет |
| `transcription_settings_get` | Да | Да | Да | Нет |
| `transcription_settings_set` | Да | Да | Нет | Нет |

## Дополнения личного MCP-клиента

Источник: `identity/tool_client.py`. Private файловые порты повторно проверяют UID/owner/Auth; каталог сам по себе не даёт право вызова.

| Имя | creator | admin | user | guest |
| --- | --- | --- | --- | --- |
| `brai_login` | Да | Да | Да | Нет |
| `brai_telegram_link_account` | Да | Да | Да | Нет |
| `brai_telegram_unlink_account` | Да | Да | Да | Нет |
| `publish_file` | Да | Да | Да | Нет |
| `fetch_file` | Да | Да | Да | Да |
| `create_text_file` | Да | Да | Да | Да |
| `read_text_file` | Да | Да | Да | Да |

## Native Hermes

Ниже перечислен базовый набор Telegram платформы закреплённого движка `517b5e10febd619ce30bb22580e29b160266eb43` (`toolsets.py`, `_HERMES_CORE_TOOLS`) и owner-bound MemOS provider. Это инвентаризация исходников движка, а не подтверждение запущенного экземпляра. Platform/toolset, provider и действующая изоляция могут дополнительно сужать набор. Опциональные desktop/другие каналы и произвольные внешние плагины не являются базовой поставкой Telegram Brai.

Для creator/admin/user действует существующий зарегистрированный native-каталог; каждому фактическому вызову предшествует проверка роли и поколения. Для guest разрешены только шесть точных имён MemOS; terminal, браузер, файлы по пути, cron, skills, delegates и исполнение запрещены также при прямом вызове. Приглашение, USER/SOUL или личный config не расширяют таблицу.

| Имя | creator | admin | user | guest |
| --- | --- | --- | --- | --- |
| `browser_back` | Да | Да | Да | Нет |
| `browser_cdp` | Да | Да | Да | Нет |
| `browser_click` | Да | Да | Да | Нет |
| `browser_console` | Да | Да | Да | Нет |
| `browser_dialog` | Да | Да | Да | Нет |
| `browser_exec` | Да | Да | Да | Нет |
| `browser_get_images` | Да | Да | Да | Нет |
| `browser_navigate` | Да | Да | Да | Нет |
| `browser_press` | Да | Да | Да | Нет |
| `browser_scroll` | Да | Да | Да | Нет |
| `browser_snapshot` | Да | Да | Да | Нет |
| `browser_type` | Да | Да | Да | Нет |
| `browser_vault_enter_code` | Да | Да | Да | Нет |
| `browser_vault_fill` | Да | Да | Да | Нет |
| `browser_vault_list` | Да | Да | Да | Нет |
| `browser_vault_save_login` | Да | Да | Да | Нет |
| `browser_vault_unlock` | Да | Да | Да | Нет |
| `browser_vision` | Да | Да | Да | Нет |
| `clarify` | Да | Да | Да | Нет |
| `computer_use` | Да | Да | Да | Нет |
| `cronjob_manage` | Да | Да | Да | Нет |
| `delegate_task` | Да | Да | Да | Нет |
| `execute_code` | Да | Да | Да | Нет |
| `image_generate` | Да | Да | Да | Нет |
| `kanban_attach` | Да | Да | Да | Нет |
| `kanban_attach_url` | Да | Да | Да | Нет |
| `kanban_attachments` | Да | Да | Да | Нет |
| `kanban_block` | Да | Да | Да | Нет |
| `kanban_comment` | Да | Да | Да | Нет |
| `kanban_complete` | Да | Да | Да | Нет |
| `kanban_create` | Да | Да | Да | Нет |
| `kanban_heartbeat` | Да | Да | Да | Нет |
| `kanban_link` | Да | Да | Да | Нет |
| `kanban_list` | Да | Да | Да | Нет |
| `kanban_request_changes` | Да | Да | Да | Нет |
| `kanban_request_review` | Да | Да | Да | Нет |
| `kanban_show` | Да | Да | Да | Нет |
| `kanban_unblock` | Да | Да | Да | Нет |
| `manage_connections` | Да | Да | Да | Нет |
| `memory` | Да | Да | Да | Нет |
| `memos_forget` | Да | Да | Да | Да |
| `memos_read` | Да | Да | Да | Да |
| `memos_remember` | Да | Да | Да | Да |
| `memos_replace` | Да | Да | Да | Да |
| `memos_search` | Да | Да | Да | Да |
| `memos_status` | Да | Да | Да | Да |
| `patch` | Да | Да | Да | Нет |
| `process_manage` | Да | Да | Да | Нет |
| `read_file` | Да | Да | Да | Нет |
| `search_files` | Да | Да | Да | Нет |
| `session_search` | Да | Да | Да | Нет |
| `skill_manage` | Да | Да | Да | Нет |
| `skill_view` | Да | Да | Да | Нет |
| `skills_list` | Да | Да | Да | Нет |
| `terminal` | Да | Да | Да | Нет |
| `text_to_speech` | Да | Да | Да | Нет |
| `todo_list` | Да | Да | Да | Нет |
| `vision_analyze` | Да | Да | Да | Нет |
| `web_extract` | Да | Да | Да | Нет |
| `web_search` | Да | Да | Да | Нет |
| `write_file` | Да | Да | Да | Нет |

## Служебные границы

Административные просмотры Control требуют creator/admin и аудита до чтения. `identity.get` доступен только доверенному root stdio для обновления профиля; Unix worker его не получает. `permissions.bootstrap` и `native.catalog` дают при подготовке только сведения и каталог. `native.authorize`, фактические data/tool ports и cron требуют active Auth и подходящего применённого поколения.

Гостевой `files.publish` разрешает только точные входные байты с root-owned ingress-квитанцией. Создание нового файла идёт через `files.create-text`, а доставка — по собственному artifactId. Общая публикация произвольного пути запрещена. Ни один из этих служебных портов не добавляет модели shell, ownerId или выбор чужого профиля.

## Виртуальный каталог MCP движка

Native SDK при отложенной выдаче схем использует метаинструменты. Это отдельный слой поверх зарегистрированных MCP-инструментов. Для guest trusted config задаёт `tools.tool_search.enabled: off`: модель получает непосредственно разрешённые `mcp__brai__*` схемы, а общие метаимена ей не выдаются.

| Имя | creator | admin | user | guest |
| --- | --- | --- | --- | --- |
| `tool_search` | Да, если включён режим | Да, если включён режим | Да, если включён режим | Нет |
| `tool_describe` | Да, если включён режим | Да, если включён режим | Да, если включён режим | Нет |
| `tool_call` | Да, если включён режим | Да, если включён режим | Да, если включён режим | Нет |

Метаинструменты используют уже подключённые MCP-серверы; права и владелец каждого фактического вызова повторно проверяются соответствующим портом. Источники закреплённого native SDK: `model_tools.py` и `tools/tool_search.py`; настройки роли — `profiles.py`.
