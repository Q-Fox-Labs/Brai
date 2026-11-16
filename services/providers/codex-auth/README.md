# Закрытая авторизация отдельного Codex

Программа выделена из проверенного механизма Bug Hunt, обсуждённого 16 ноября
2026 года. Это повторное использование способа доступа к существующему owner;
новая OAuth-учётная запись и HTTP model gateway не создаются.

[RPC](openrpc.json): credentials.status и credentials.resolve.
Helper проверяет отдельный peer UID через SO_PEERCRED, Root-owned inputs,
точные provider-source receipts и общий owner resolver. Смена binding закрывает
старую фазу. Refresh сериализован прежним owner lock; неизвестный исход хранится
через restart и не разрешает слепой повтор. Client выводит только access для
native auth.command. Refresh token не выдаётся и auth.json не копируется.

Root launcher и независимый supervisor принадлежат установке потребителя.
Helper не подключается к Hermes/broker/egress. Закреплённые provider-source
байты и credentials DATA должны сохраняться отдельно от остановки и уборки
Hermes; имя пути исходного resolver не означает зависимость от процесса Hermes.
Helper/state/inputs/cgroup регистрируются самостоятельным component owner.

Запуск: принятый Python -I -S -B helper.py --config ROOT_JSON --listen-fd FD.
Config: version=1, socket, stateRoot, peerUid, provider из verified source receipt.
Root создаёт listener, проверяет полный source/producer и закрытый namespace,
затем запускает helper под provider UID с отдельными ownerHome/codexHome rw
mounts и read-only closed config. Worker не видит owner DATA и не входит в его
группу. Node native работает под отдельным peer UID и получает только private RPC.

`python3 -I -B -m unittest discover -s services/providers/codex-auth` проверяет
синтетические credentials и реальные Unix sockets. Успех этих тестов не
подтверждает реальную Luna или установку сервиса.
