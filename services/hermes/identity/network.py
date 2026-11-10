# ABOUTME: Передаёт соединения локального HTTP-прокси в доверенный Unix-сокет.
# ABOUTME: Запускается под UID профиля внутри его отдельного сетевого пространства.
import argparse
import asyncio
import json
import logging
from pathlib import Path
import time
import uuid


def _timeout_policy():
    """Прочитать тот же контракт, который проверяет личный модельный клиент."""
    path = Path(__file__).resolve().parents[1] / 'extensions/config/network-timeouts.json'
    value = json.loads(path.read_bytes())
    fields = {'version', 'max_client_silence_seconds', 'transport_idle_grace_seconds'}
    if (not isinstance(value, dict) or set(value) != fields
            or type(value['version']) is not int or value['version'] != 1
            or any(type(value[key]) is not int or value[key] <= 0 for key in fields - {'version'})):
        raise ValueError('INVALID_NETWORK_TIMEOUT_POLICY')
    return value


TIMEOUT_POLICY = _timeout_policy()
MAX_NATIVE_SILENCE_SECONDS = TIMEOUT_POLICY['max_client_silence_seconds']
TRANSPORT_IDLE_GRACE_SECONDS = TIMEOUT_POLICY['transport_idle_grace_seconds']
IDLE_TIMEOUT = MAX_NATIVE_SILENCE_SECONDS + TRANSPORT_IDLE_GRACE_SECONDS
DRAIN_TIMEOUT = 120
CONNECT_TIMEOUT = 5
MAX_CONNECTIONS = 128
BUFFER_SIZE = 65536
LOGGER = logging.getLogger(__name__)


class IdleTimeout(asyncio.TimeoutError):
    """Оба направления не передавали байты в течение срока бездействия."""


class DrainTimeout(asyncio.TimeoutError):
    """Получатель не принял данные за отведённый срок."""


async def _copy(reader, writer, activity):
    while True:
        data = await reader.read(BUFFER_SIZE)
        if not data:
            try:
                writer.write_eof()
            except (AttributeError, OSError, RuntimeError, NotImplementedError):
                pass
            return
        activity.set()
        writer.write(data)
        try:
            await asyncio.wait_for(writer.drain(), DRAIN_TIMEOUT)
        except asyncio.TimeoutError:
            raise DrainTimeout from None


async def _duplex(a_reader, a_writer, b_reader, b_writer):
    """Передавать оба направления с общим сроком бездействия соединения."""
    activity = asyncio.Event()

    async def idle():
        while True:
            activity.clear()
            try:
                await asyncio.wait_for(activity.wait(), IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                raise IdleTimeout from None

    copies = [asyncio.create_task(_copy(a_reader, b_writer, activity)),
              asyncio.create_task(_copy(b_reader, a_writer, activity))]
    watchdog = asyncio.create_task(idle())
    combined = asyncio.gather(*copies)
    try:
        done, _ = await asyncio.wait((combined, watchdog), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    finally:
        for task in copies + [watchdog]:
            task.cancel()
        await asyncio.gather(combined, watchdog, return_exceptions=True)


async def _relay(reader, writer, socket_path):
    upstream = None
    connection_id = uuid.uuid4().hex
    started = time.monotonic()
    stage, reason = 'connect', 'complete'
    try:
        source, upstream = await asyncio.wait_for(asyncio.open_unix_connection(socket_path), CONNECT_TIMEOUT)
        stage = 'transfer'
        await _duplex(reader, writer, source, upstream)
    except IdleTimeout:
        reason = 'idle'
    except DrainTimeout:
        reason = 'drain'
    except asyncio.TimeoutError:
        reason = 'connect'
    except (OSError, ConnectionError):
        reason = 'connect' if stage == 'connect' else 'peer_error'
    except asyncio.CancelledError:
        reason = 'cancel'
        raise
    finally:
        LOGGER.info('connection=%s stage=%s elapsed=%.3f reason=%s',
                    connection_id, stage, time.monotonic() - started, reason)
        for stream in (writer, upstream):
            if stream is not None:
                stream.close()
        for stream in (writer, upstream):
            if stream is not None:
                try:
                    await stream.wait_closed()
                except OSError:
                    pass


async def start_relay(socket_path, port=18080):
    """Открыть loopback-прокси; вызывающий закрывает возвращённый сервер."""
    semaphore = asyncio.Semaphore(MAX_CONNECTIONS)
    async def handle(reader, writer):
        if semaphore.locked():
            writer.close()
            return
        async with semaphore:
            await _relay(reader, writer, socket_path)
    return await asyncio.start_server(handle, "127.0.0.1", port, limit=BUFFER_SIZE)


async def _main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    server = await start_relay(args.socket, args.port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(_main())
