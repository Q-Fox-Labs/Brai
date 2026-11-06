# ABOUTME: Передаёт соединения локального HTTP-прокси в доверенный Unix-сокет.
# ABOUTME: Запускается под UID профиля внутри его отдельного сетевого пространства.
import argparse
import asyncio

IDLE_TIMEOUT = 120
BUFFER_SIZE = 65536


async def _copy(reader, writer):
    while True:
        data = await asyncio.wait_for(reader.read(BUFFER_SIZE), IDLE_TIMEOUT)
        if not data:
            try:
                writer.write_eof()
            except (AttributeError, OSError, RuntimeError):
                pass
            return
        writer.write(data)
        await asyncio.wait_for(writer.drain(), IDLE_TIMEOUT)


async def _relay(reader, writer, socket_path):
    upstream = None
    tasks = []
    try:
        source, upstream = await asyncio.wait_for(asyncio.open_unix_connection(socket_path), 5)
        tasks = [asyncio.create_task(_copy(reader, upstream)),
                 asyncio.create_task(_copy(source, writer))]
        await asyncio.gather(*tasks)
    except (OSError, asyncio.TimeoutError, ConnectionError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
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
    semaphore = asyncio.Semaphore(128)
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
    server = await start_relay(args.socket, args.port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(_main())
