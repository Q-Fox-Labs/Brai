# Codex CLI search bridge

Hermes сохраняет свой agent loop; официальный установленный Codex CLI выполняет только поиск через web.search_backend: codex-cli и возвращает native web_search text_result, не сгенерированный ответ. Core не патчится.

В исходной проверке direct Responses hosted web_search завершался server_error, а CLI на том же аккаунте/модели работал; текущее состояние проверяй заново. Авторизация — существующий Codex login, без нового/скопированного API-ключа.

Каждый запрос — временная read-only сессия в пустом каталоге; команды/apps/plugins/browser/delegation отключены. Timeout 90 с, прерывание убирает дочерние процессы; штатные cache/truncation поиска Hermes сохраняются.

plugins.entries.codex-cli-search: model=gpt-6.1-sol, timeout_seconds=90, binary=codex (необязательные). Откат: web.search_backend=openai-native, disable плагина и штатный restart после задач; прежний provider error должен быть независимо исправлен. Артефакты проверки — ${HERMES_HOME}/diagnostics/.
