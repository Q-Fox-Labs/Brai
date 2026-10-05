# Проверка вложений в Chrome

Проводить в выделенном браузерном контексте и только с учётной записью
`attachments-test@brai.invalid`, предварительно внесённой и в
`BRAI_ACCEPTANCE_TEST_EMAILS`, и в web `BRAI_AGENT_ALLOWED_EMAILS`. Для каждой страницы сохранить свой `pageId` и
явно передавать его всем page-инструментам. Закрыть только созданные здесь
страницы.

1. Открыть `http://127.0.0.1:13000`, запросить одноразовый код. Получить его
через loopback callback `http://127.0.0.1:13006/__test/otp?address=attachments-test%40brai.invalid`;
код существует в памяти fixture до первого чтения. Войти и проверить, что
открыта тестовая учётная запись.
2. Создать native thread, выбрать его, дождаться открытия и connected snapshot
для того же thread. Файл [native-fixture.mjs](native-fixture.mjs) должен
подключаться к agent как Unix WebSocket и показывать пометку fake inference в
отчёте. Отправить маленький PNG через UI. Снять HTTP/NATS/SSE трассу только
для адресов тестового стенда.
3. Убедиться, что экран показывает готовое вложение; metadata содержит точный
user, project, thread, item и turn. Подтвердить, что сырые image bytes идут по
same-origin PUT `/upload/{token}`, а prepare/finalize и NATS/SSE содержат только
metadata/reference, без base64 или байтов файла.
4. Открыть полученное изображение по его same-origin URL. Проверить `GET`,
   `HEAD`, диапазон bytes, conditional request и safe headers публичного
   attachment response: MIME, inline disposition, no-store, nosniff,
   same-origin CORP и `X-Frame-Options: SAMEORIGIN`. Отдельный ответ
   `/api/agent/artifact-auth` возвращает `X-Frame-Options: DENY`.
5. Перезагрузить страницу, снова выбрать и открыть thread. Повторить после
   остановки и запуска только тестового agent; восстановление опирается на
   native `userMessage.clientId` и durable artifact reference.
6. Пока fake turn активен (fixture hold по умолчанию 60 секунд), отправить второе
   изображение через steer с собственным `clientUserMessageId`. Убедиться, что
   second item получил самостоятельную reference, а завершение turn доходит после
   переподключения agent.
7. Проверить legacy item без reference: UI показывает индикатор отсутствия
   вложения. Удалить отдельный test artifact; тот же item должен показывать
   удалённое состояние без попытки скачать файл.
8. Проверить отрицательные случаи на тестовых UUID: другой user/project/thread,
   незакрытый pending reference, неверная пара item/turn, повтор query key,
   неверный forwarded method, истёкшая сессия и удалённый файл. Ссылка не
   должна раскрыть содержимое или чужие metadata.
9. Остановить только test artifact controller, PG и NATS, оставить files Caddy
   работающим и повторить уже разрешённый внутренний GET/HEAD/range; затем
   перезапустить files Caddy без volume init и повторить hash. Браузерный
   auth-protected URL в этот этап отдельно интерпретируется по исходному
   маршруту и не подменяет проверку внутреннего URI.
10. Приложить в `tmp/` page/console/network заметки без cookies, токенов,
    содержимого сообщений и файлов. Указать, что fake native не запускал
    inference.
