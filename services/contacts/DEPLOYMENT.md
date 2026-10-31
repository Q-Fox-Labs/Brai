# Запуск Контактов

Компонент contacts собирается и упаковывается штатным component CLI.
Новые пакеты не устанавливаются: используются подготовленные зависимости.
Самостоятельный процесс не требует Приёма, Temporal, Telegram и ИИ.

CONTACTS_CONFIG указывает защищённый JSON с databaseUrl (runtime-роль),
natsUrl, natsOptionsFile, cursorKeyFile и callers.
Каждый caller содержит ownerIds, sourceIds и operations. Доступ к чтению
контактов владельца выдаётся отдельно от resolve/profile.observe.
NATS credentials разрешают только соответствующие subjects и reply inbox.
Ключ HMAC — минимум 32 байта, неизменный после перезапуска/восстановления.
Логи не содержат конфигурацию или профили.

Owner создаёт отдельную БД и ограниченную runtime-роль заранее.
Отдельный запуск dist/migrate.js получает CONTACTS_OWNER_DATABASE_URL и
CONTACTS_RUNTIME_ROLE; эти credentials не попадают в main.
Миграция идемпотентна, не удаляет записи. Runtime имеет SELECT/INSERT
и только обновление проекции профиля; не DDL, DELETE или UPDATE квитанций.

Main: node services/contacts/dist/main.js с CONTACTS_CONFIG.
Готовность: NATS brai.contacts.v1.status с пустым объектом; PING недостаточно.
Ограничения: 8 активных операций, pool 4, deadline 5 секунд,
64 KiB вход, 128 KiB результат; BUSY повторяет вызывающий сценарий.
После timeout слот освобождается только после завершения SQL.

compose.yml принимает уже подготовленный immutable образ по digest, выделенную
сеть и read-only runtime inputs. Owner env используется только профилем setup.
Операторские установщики и общие роли находятся в Admin; наличие компонента
не включает его в принятый клиентский состав.

Резервировать нужно БД contacts и стабильный ключ курсоров. Откат образа не
удаляет данные и не переписывает наблюдения. Выпуск и переключение Telegram
разрешаются только позднее в составе согласованного полного комплекта.
