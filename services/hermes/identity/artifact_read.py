# ABOUTME: Передаёт ingress один read-only inode без каталога и копии файла.
# ABOUTME: JSON-RPC metadata сопровождается SCM_RIGHTS; worker не получает этот порт.
import array
import asyncio
import contextlib
import fcntl
import hashlib
import io
import json
import os
import socket
import stat
import struct
import uuid

MAX_FRAME = 32768
MAX_FILE = 64 * 1024 * 1024
FIELDS = ('artifactId', 'filename', 'mimeType', 'sizeBytes', 'sha256')


async def ready(sock, *, writing=False):
    """Дождаться readiness без потока, который мог бы пережить отмену."""
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    def wake():
        if not future.done():
            future.set_result(None)
    add = loop.add_writer if writing else loop.add_reader
    remove = loop.remove_writer if writing else loop.remove_reader
    add(sock.fileno(), wake)
    try:
        await future
    finally:
        remove(sock.fileno())


async def verify(fd, metadata):
    """Проверить ограниченный стабильный regular inode и вернуть курсор в начало."""
    if (set(metadata) != set(FIELDS) or str(uuid.UUID(metadata['artifactId'])) != metadata['artifactId']
            or not isinstance(metadata['filename'], str) or not metadata['filename']
            or metadata['filename'] in ('.', '..') or '/' in metadata['filename'] or '\\' in metadata['filename']
            or not isinstance(metadata['mimeType'], str) or not metadata['mimeType']
            or type(metadata['sizeBytes']) is not int or not 0 <= metadata['sizeBytes'] <= MAX_FILE
            or not isinstance(metadata['sha256'], str) or len(metadata['sha256']) != 64):
        raise ValueError('Invalid artifact metadata')
    before = os.fstat(fd)
    if (fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY
            or not stat.S_ISREG(before.st_mode) or before.st_size != metadata['sizeBytes']):
        raise PermissionError('Invalid artifact descriptor')
    digest, size = hashlib.sha256(), 0
    os.lseek(fd, 0, os.SEEK_SET)
    while chunk := os.read(fd, 1024 * 1024):
        size += len(chunk)
        if size > MAX_FILE:
            raise ValueError('Artifact too large')
        digest.update(chunk)
        await asyncio.sleep(0)
    after = os.fstat(fd)
    if (size != metadata['sizeBytes'] or digest.hexdigest() != metadata['sha256']
            or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
               (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise PermissionError('Artifact changed or hash mismatch')
    os.lseek(fd, 0, os.SEEK_SET)


async def send_response(writer, response, fd=None):
    """Передать один FD только с первым байтом ответа; partial write не повторяет grant."""
    encoded = json.dumps(response, ensure_ascii=False).encode() + b'\n'
    if len(encoded) > MAX_FRAME:
        raise ValueError('Artifact response too large')
    with socket.socket(fileno=os.dup(writer.get_extra_info('socket').fileno())) as peer:
        peer.setblocking(False)
        async with asyncio.timeout(5):
            controls = [] if fd is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))]
            while True:
                try:
                    sent = peer.sendmsg([encoded], controls)
                    break
                except BlockingIOError:
                    await ready(peer, writing=True)
            if sent <= 0:
                raise ConnectionError('Artifact response unavailable')
            await asyncio.get_running_loop().sock_sendall(peer, encoded[sent:])


class ArtifactReader(io.BufferedReader):
    """Сохранить исходное имя для Telegram без открытия пути в хранилище."""
    def __init__(self, fd, filename):
        self.filename = filename
        super().__init__(io.FileIO(fd, 'rb', closefd=True))

    @property
    def name(self):
        return self.filename


def peer_uid(peer):
    return struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]


async def receive_artifact(params, timeout=120):
    """Получить ровно один root-issued O_RDONLY FD; закрыть всё при любой отмене."""
    path = os.environ.get('BRAI_IDENTITY_BROKER', '')
    if not path.startswith('/'):
        raise PermissionError('Broker unavailable')
    descriptors = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.setblocking(False)
        try:
            async with asyncio.timeout(timeout):
                loop = asyncio.get_running_loop()
                await asyncio.wait_for(loop.sock_connect(peer, path), 3)
                uid = peer_uid(peer)
                if uid != 0:
                    raise PermissionError('Unexpected broker UID')
                request_id = uuid.uuid4().hex
                wire = json.dumps({'jsonrpc': '2.0', 'id': request_id,
                    'method': 'ingress.open-artifact', 'params': params}).encode() + b'\n'
                if len(wire) > MAX_FRAME:
                    raise ValueError('Artifact request too large')
                await loop.sock_sendall(peer, wire)
                frame = bytearray()
                while b'\n' not in frame:
                    try:
                        chunk, controls, flags, _ = peer.recvmsg(MAX_FRAME + 1 - len(frame),
                            socket.CMSG_SPACE(4 * array.array('i').itemsize), socket.MSG_CMSG_CLOEXEC)
                    except BlockingIOError:
                        await ready(peer)
                        continue
                    for level, kind, data in controls:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            values = array.array('i')
                            values.frombytes(data[:len(data) - len(data) % values.itemsize])
                            descriptors.extend(values)
                    if flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or len(descriptors) > 1:
                        raise ValueError('Invalid artifact descriptor count')
                    frame.extend(chunk)
                    if not chunk or len(frame) > MAX_FRAME:
                        raise ValueError('Invalid artifact response')
                if not frame.endswith(b'\n') or frame.count(b'\n') != 1:
                    raise ValueError('Invalid artifact frame')
                response = json.loads(frame)
                if (not isinstance(response, dict) or set(response) != {'jsonrpc', 'id', 'result'}
                        or response['jsonrpc'] != '2.0' or response['id'] != request_id
                        or len(descriptors) != 1 or not isinstance(response['result'], dict)
                        or response['result'].get('artifactId') != params['artifactId']):
                    raise PermissionError('Artifact request rejected')
                metadata = response['result']
                await verify(descriptors[0], metadata)
                stream = ArtifactReader(descriptors[0], metadata['filename'])
                descriptors.clear()
                return metadata, stream
        finally:
            for fd in descriptors:
                os.close(fd)


async def transcode_voice(source):
    """Создать Ogg/Opus через stdin FD; производный результат ограничен и не пишется на диск."""
    process = await asyncio.create_subprocess_exec('ffmpeg', '-v', 'error', '-i', 'pipe:0',
        '-acodec', 'libopus', '-ac', '1', '-b:a', '32k', '-vbr', 'on',
        '-application', 'voip', '-compression_level', '10', '-f', 'ogg', 'pipe:1',
        stdin=source, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(60):
            output = io.BytesIO()
            while chunk := await process.stdout.read(1024 * 1024):
                if output.tell() + len(chunk) > MAX_FILE:
                    raise ValueError('Converted voice too large')
                output.write(chunk)
            if await process.wait() != 0 or output.tell() == 0:
                raise ValueError('Voice conversion unavailable')
            output.name = 'voice.ogg'
            output.seek(0)
            return output
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
