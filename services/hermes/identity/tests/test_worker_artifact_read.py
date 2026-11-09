# ABOUTME: Проверяет настоящий SCM_RIGHTS, отмену и read-only доступ к одному артефакту.
# ABOUTME: Использует только синтетические файлы и Unix socket без Telegram и модели.
import asyncio
import array
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from identity import artifact_read as transfer
from identity.broker import artifact_response


class ArtifactReadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'speech.ogg'
        self.path.write_bytes(b'OggS original voice')
        self.metadata = {'artifactId': str(uuid.uuid4()), 'filename': 'speech.ogg',
            'mimeType': 'audio/ogg', 'sizeBytes': self.path.stat().st_size,
            'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        self.params = {'uid': 1006, 'artifactId': self.metadata['artifactId']}
        self.socket = str(self.root / 'broker.sock')
        self.env = patch.dict(os.environ, {'BRAI_IDENTITY_BROKER': self.socket})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.peer = patch.object(transfer, 'peer_uid', return_value=0)
        self.peer.start()
        self.addCleanup(self.peer.stop)
        self.tasks = set()
        self.server = None
        self.server_fds = []

    async def asyncTearDown(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for fd in self.server_fds:
            with self.assertRaises(OSError):
                os.fstat(fd)

    async def listen(self, handler=None):
        async def grant(uid, params):
            self.assertEqual(uid, os.getuid())
            self.assertEqual(params, self.params)
            fd = os.open(self.path, os.O_RDONLY)
            self.server_fds.append(fd)
            return dict(self.metadata), fd
        broker = SimpleNamespace(open_artifact=grant)
        async def accept(reader, writer):
            task = asyncio.current_task()
            self.tasks.add(task)
            try:
                raw = await reader.readline()
                if not raw:
                    return
                request = json.loads(raw)
                if handler:
                    await handler(request, writer)
                else:
                    await artifact_response(broker, os.getuid(), request, writer)
            finally:
                writer.close()
                await writer.wait_closed()
                self.tasks.discard(task)
        self.server = await asyncio.start_unix_server(accept, self.socket)

    def count_fds(self):
        return len(list(Path('/proc/self/fd').iterdir()))

    async def test_reads_same_inode_and_cannot_write_without_delivery_directory(self):
        await self.listen()
        metadata, stream = await transfer.receive_artifact(self.params)
        with stream:
            self.assertEqual(metadata, self.metadata)
            self.assertNotIn('localPath', metadata)
            self.assertEqual(stream.name, 'speech.ogg')
            self.assertEqual(os.fstat(stream.fileno()).st_ino, self.path.stat().st_ino)
            self.assertFalse(os.get_inheritable(stream.fileno()))
            with self.assertRaises(OSError):
                os.write(stream.fileno(), b'changed')
            with self.assertRaises(OSError):
                os.ftruncate(stream.fileno(), 0)
            self.path.unlink()
            self.assertEqual(stream.read(), b'OggS original voice')
        self.assertFalse((self.root / 'delivery').exists())

    async def test_wrong_peer_is_rejected_before_request(self):
        await self.listen()
        with patch.object(transfer, 'peer_uid', return_value=1234):
            with self.assertRaises(PermissionError):
                await transfer.receive_artifact(self.params)

    async def test_wrong_artifact_id_closes_received_descriptor(self):
        async def handler(request, writer):
            fd = os.open(self.path, os.O_RDONLY)
            try:
                response = {'jsonrpc': '2.0', 'id': request['id'], 'result': self.metadata}
                await transfer.send_response(writer, response, fd)
                # Переданный FD должен быть закрыт при несовпадении artifactId.
            finally:
                os.close(fd)
        await self.listen(handler)
        before = self.count_fds()
        with self.assertRaises(PermissionError):
            await transfer.receive_artifact({**self.params, 'artifactId': str(uuid.uuid4())})
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_partial_valid_frame_keeps_exactly_one_descriptor(self):
        async def handler(request, writer):
            raw = json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': self.metadata}).encode() + b'\n'
            fd = os.open(self.path, os.O_RDONLY)
            try:
                with socket.socket(fileno=os.dup(writer.get_extra_info('socket').fileno())) as peer:
                    peer.sendmsg([raw[:10]], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
                await asyncio.sleep(0.01)
                writer.write(raw[10:])
                await writer.drain()
            finally:
                os.close(fd)
        await self.listen(handler)
        metadata, stream = await transfer.receive_artifact(self.params)
        with stream:
            self.assertEqual(stream.read(), b'OggS original voice')

    async def test_writable_descriptor_is_rejected_and_closed(self):
        async def handler(request, writer):
            fd = os.open(self.path, os.O_RDWR)
            try:
                await transfer.send_response(writer, {'jsonrpc': '2.0', 'id': request['id'],
                    'result': self.metadata}, fd)
            finally:
                os.close(fd)
        await self.listen(handler)
        before = self.count_fds()
        with self.assertRaises(PermissionError):
            await transfer.receive_artifact(self.params)
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_hash_mismatch_closes_received_descriptor(self):
        await self.listen()
        self.metadata['sha256'] = '0' * 64
        before = self.count_fds()
        with self.assertRaises(PermissionError):
            await transfer.receive_artifact(self.params)
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_extra_rights_are_closed(self):
        async def handler(request, writer):
            response = json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                                   'result': self.metadata}).encode() + b'\n'
            fd = os.open(self.path, os.O_RDONLY)
            try:
                with socket.socket(fileno=os.dup(writer.get_extra_info('socket').fileno())) as peer:
                    peer.sendmsg([response], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd, fd]))])
            finally:
                os.close(fd)
        await self.listen(handler)
        before = self.count_fds()
        with self.assertRaises(ValueError):
            await transfer.receive_artifact(self.params)
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_cancel_after_rights_before_complete_frame_closes_descriptor(self):
        sent = asyncio.Event()
        async def handler(request, writer):
            fd = os.open(self.path, os.O_RDONLY)
            try:
                with socket.socket(fileno=os.dup(writer.get_extra_info('socket').fileno())) as peer:
                    peer.sendmsg([b'{"jsonrpc":'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
                sent.set()
                await asyncio.Event().wait()
            finally:
                os.close(fd)
        await self.listen(handler)
        before = self.count_fds()
        task = asyncio.create_task(transfer.receive_artifact(self.params))
        await sent.wait()
        await asyncio.sleep(0.01)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        for server_task in list(self.tasks):
            server_task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_timeout_after_rights_closes_descriptor(self):
        async def handler(request, writer):
            fd = os.open(self.path, os.O_RDONLY)
            try:
                with socket.socket(fileno=os.dup(writer.get_extra_info('socket').fileno())) as peer:
                    peer.sendmsg([b'{'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
                await asyncio.Event().wait()
            finally:
                os.close(fd)
        await self.listen(handler)
        before = self.count_fds()
        with self.assertRaises(TimeoutError):
            await transfer.receive_artifact(self.params, timeout=0.05)
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.sleep(0.01)
        self.assertEqual(self.count_fds(), before)

    async def test_response_without_rights_and_wrong_rpc_id_are_rejected(self):
        async def handler(request, writer):
            await transfer.send_response(writer, {'jsonrpc': '2.0', 'id': 'wrong', 'result': self.metadata})
        await self.listen(handler)
        with self.assertRaises(PermissionError):
            await transfer.receive_artifact(self.params)

    async def test_transcode_reads_fd_without_local_path(self):
        import shutil
        if not shutil.which('ffmpeg'):
            self.skipTest('Operator ffmpeg unavailable')
        import wave
        wav = self.root / 'voice.wav'
        with wave.open(str(wav), 'wb') as target:
            target.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            target.writeframes(b'\0\0' * 1600)
        with wav.open('rb') as source:
            converted = await transfer.transcode_voice(source)
        with converted:
            self.assertEqual(converted.read(4), b'OggS')
            self.assertEqual(converted.name, 'voice.ogg')
