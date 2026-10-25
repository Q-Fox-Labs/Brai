# Многокубовый provider: эксплуатация

Источник истины: `${HERMES_HOME}/plugins/memos-rest/README.md`; рабочие настройки активного home `memos-rest.json`, `memos-catalog.json`. Таксономия и нейтральные defaults находятся в plugin dir. Не переносить личные сведения настройщика в настройки будущего владельца.

## Проверенные контракты и ловушки
- Используй `--scope-profile default` в admin CLI: глобальный Hermes parser поглощает `--profile`. Scope дополнительно требует root и полный список managed cubes, включая каталожные проекты.
- При explicit memory_ids в `/product/delete_memory` не передавай одновременно user_id/session_id/filter: API считает это двумя режимами и возвращает failure даже при HTTP/code 200. Сначала выбери IDs локально по user/cube, затем передай writable_cube_ids+memory_ids и сделай read-back.
- Проверяй настоящий backend, а не только fake API: смысловое разделение, overlap и общий logical ID, source links, поиск/дедупликация, согласованная правка/удаление всех копий, защита чужого автора, удаление проб.
- Факты хранят только минимальный source quote и ссылку на оригинал; не копируй весь исходный диалог в metadata каждой тематической копии.
- MemoryProvider lifecycle не является generic plugin hook bus. Не объявляй memory lifecycle методы в plugin.yaml hooks: plugin doctor иначе сообщает неизвестные/незарегистрированные hooks.
- `hermes plugins enable`/reload-plugins не доказывает обновление уже созданных MemoryProvider objects и writer threads. Проверяй живой memos_status; legacy ответ без phase/epoch/cubes указывает на старый объект, даже если свежий CLI уже видит новую конфигурацию.
- Не обходи блокировку restart/stop gateway изнутри своего процесса посредством systemctl, таймера, detached kill или control-socket обхода. Попроси штатный пользовательский `/restart`. После epoch purge нужен также `/new`: старые canonical sessions намеренно отозваны.

## Защита массовой очистки и пауза backend
- Перед любым изменением/удалением памяти active default прочитай `${HERMES_HOME}/MEMORY_POLICY.md`. Обычная просьба очистить всю память не разрешает отключить `bulk_clear_locked` или обойти отказ прямым SQL/HTTP/перебором forget. Нужны отдельное подтверждение владельца после предупреждения и явное разрешение разовой разблокировки; затем защита возвращается.
- Admin purge/handoff проверяют `bulk_clear_locked=true` под lock и отказывают до API вызовов, в том числе со старой строкой CLI confirm. Точечное явно согласованное forget не является массовой очисткой.
- `backend_write_paused=true` означает отдельно остановленную запись PostgreSQL, а не только frozen в JSON. Resume обязан отказать, пока backend pause не снята проверяемо.
- Чтобы старый legacy writer не наполнял кубы после очистки, можно в явно согласованной области временно отозвать INSERT/UPDATE на memos.memories и memos.edges у настроенной роли memos_app. Чтение/DELETE оставляются; изменения ролей и чужих схем не нужны. В этом deployment postgres не может SET ROLE memos_app; используй уже настроенное подключение роли-владельца внутри memos-api, не меняй membership. Значения POSTGRES_* никогда не выводить.
- Возобновление записи — отдельное разрешение владельца: проверить загрузку нового provider и отсутствие старых writers; восстановить предыдущие INSERT/UPDATE правами владельца; read-back; снять backend_write_paused и вызвать resume. bulk_clear_locked остаётся true; старые очереди и отозванные сессии не переимпортировать.

## Setup и handoff
- До передачи deployment_phase=setup; никаких автоматических переключений production. Код/нейтральная taxonomy отдельно от предпередаточных пользовательских данных.
- prepare настраивает router и локальный catalog (не создаёт backend cubes), оставляет frozen. purge чистит managed MemOS cubes и pending/receipts без backup, меняет epoch и оставляет setup frozen. resume разрешает запись. handoff чистит аналогично, выбирает production и тоже оставляет frozen до resume.
- Статус frozen не доказывает остановку ранее загруженного legacy writer без guard. При таком deployment сначала завершить штатную загрузку нового runtime, затем перепроверить/повторить purge перед объявлением устойчивой пустоты.
- При передаче очисти встроенные MEMORY.md/USER.md штатным `hermes memory reset --yes --target all` только в согласованном active profile; затем проверь отсутствие файлов.
- Admin epoch/session fence предотвращает повторный импорт старых session_end/checkpoints/rewind и stale jobs. Он НЕ уничтожает историю Hermes/state.db, Telegram, журналы, backups/snapshots. Для требования уничтожить все предпередаточные следы нужна отдельная согласованная очистка этих хранилищ; не выдавай пустой recall за физическое уничтожение всех копий.
- Проверяй exact read-back каждой области, очередь и receipts, builtin файлы; при доступном PG дополнительно rows/edges. Не сохраняй резервную копию памяти вопреки явному запросу уничтожения.
- Секреты router читаются программно из env_file; хранить/печатать только путь и имя переменной, не значение. Значения настроек получать из живого файла, не предполагать актуальность старого venv пути.
