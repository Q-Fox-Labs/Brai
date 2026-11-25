# ABOUTME: Выполняет поручения через штатного личного Hermes и допускает только проверенный итог.
# ABOUTME: Этот порт вызывается через защищённый root Unix socket Telegram ingress.
"""Owner-bound native assignment lifecycle and approval at the delivery boundary."""
import asyncio
from pathlib import PurePath
import re
import uuid
from xml.etree import ElementTree
from zipfile import ZipFile

from .artifact_read import receive_artifact
from .delivery_journal import delivery_id
from .ipc import RpcError
from .operator_assignments import OperatorAssignments
from .reply_outbox import DeliveryDeferred

OFFICE_DOCUMENTS = {
    '.docx': ('application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
    '.pptx': ('application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
}
OFFICE_CONTENT_TYPES = '{http://schemas.openxmlformats.org/package/2006/content-types}'


class OperatorAssignmentControl:
    def __init__(self, resolver, resolve):
        self.resolver, self.resolve = resolver, resolve
        self.store = OperatorAssignments(resolver.ledger.db)
        self.tasks = {}
        self.deliveries = set()

    async def close(self):
        for task in tuple(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def target(self, userId, profileId, chat, thread, anchor):
        if (not isinstance(chat, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', chat)
                or not isinstance(thread, str) or thread == '1'
                or thread and not re.fullmatch(r'[1-9][0-9]{0,15}', thread)
                or not isinstance(anchor, str) or not re.fullmatch(r'[1-9][0-9]{0,15}', anchor)):
            raise RpcError(-32602, 'Invalid operator assignment route')
        resolved = await self.resolve('ingress.resolve-known', {'telegramId': chat})
        profile = resolved.get('profile') if isinstance(resolved, dict) and resolved.get('state') == 'known' else None
        if (not isinstance(profile, dict) or profile.get('userId') != userId or profile.get('profileId') != profileId
                or str(profile.get('telegramId')) != chat):
            raise PermissionError('Operator assignment owner changed')
        route = (chat, thread)
        ledger = self.resolver.ledger
        metadata = ledger.metadata(profile, route)
        if metadata is None or not ledger.owns(profile, route, anchor, outgoing=False):
            raise PermissionError('Unknown operator assignment anchor')
        return profile, route, metadata

    async def __call__(self, action, operationId, userId, profileId, chat, thread, anchor,
                       sessionKey=None, sessionId=None, instructions=None, requiredMimeTypes=None, resultDigest=None):
        if str(uuid.UUID(operationId)) != operationId:
            raise RpcError(-32602, 'Invalid operator assignment ID')
        profile, route, metadata = await self.target(userId, profileId, chat, thread, anchor)
        owner = self.resolver.ledger.owner(profile)
        if action == 'start':
            if (not isinstance(sessionKey, str) or not sessionKey.strip() or len(sessionKey) > 512
                    or not isinstance(sessionId, str) or not sessionId.strip() or len(sessionId) > 256
                    or not isinstance(instructions, str) or not instructions.strip()
                    or not 1 <= len(instructions.encode()) <= 48000
                    or not isinstance(requiredMimeTypes, list) or len(requiredMimeTypes) > 10
                    or any(not isinstance(item, str) or not re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', item)
                           for item in requiredMimeTypes)):
                raise RpcError(-32602, 'Invalid operator assignment')
            generation = self.resolver._chat_generation(profile, route)
            request = {'chat': chat, 'thread': thread, 'anchor': anchor,
                       'sessionKey': sessionKey, 'sessionId': sessionId, 'instructions': instructions,
                       'requiredMimeTypes': requiredMimeTypes, 'chatGeneration': generation,
                       'role': profile.get('role'), 'authGeneration': profile.get('generation')}
            self.store.create(operationId, owner, request)
            if self.resolver._startup_held() or getattr(self.resolver.release_gate, 'operation', None) is not None:
                return {'state': 'prepared'}
            peer = await self.resolver._bridge(profile).connect()
            if self.store.begin(operationId, owner):
                task = asyncio.create_task(self.run(peer, operationId, owner, userId, request))
                self.tasks[operationId] = task
                def finished(completed):
                    if self.tasks.get(operationId) is completed:
                        self.tasks.pop(operationId, None)
                task.add_done_callback(finished)
        value = self.store.read(operationId, owner)
        if (value is None or any(value['request'][key] != expected
                for key, expected in (('chat', chat), ('thread', thread), ('anchor', anchor)))):
            raise RpcError(-32602, 'Unknown operator assignment')
        if action == 'cancel':
            if self.cancel(operationId, owner):
                task = self.tasks.get(operationId)
                if task is not None:
                    peer = await self.resolver._bridge(profile).connect()
                    stopped = await peer.call('operator.assignment.cancel', {
                        'owner': userId, 'operationId': operationId}, timeout=15)
                    if stopped.get('state') in ('stopped', 'inactive'):
                        task.cancel()
        elif action == 'approve':
            await self.approve(profile, route, metadata, owner, value, resultDigest)
        elif action not in ('start', 'status'):
            raise RpcError(-32602, 'Invalid operator assignment action')
        return self.status(operationId, owner)

    @staticmethod
    def worker_params(ident, user, request):
        return {'operationId': ident, 'owner': user, **{key: request[key] for key in
            ('chat', 'thread', 'sessionKey', 'sessionId', 'chatGeneration', 'instructions')}}

    async def run(self, peer, ident, owner, user, request):
        if self.store.read(ident, owner)['state'] != 'running':
            return
        try:
            value = await peer.call('operator.assignment', self.worker_params(ident, user, request), timeout=None)
            if value.get('state') == 'busy':
                self.store.busy(ident, owner)
            elif value.get('state') == 'ready':
                self.store.ready(ident, owner, value['result'])
            else:
                self.store.fail(ident, owner)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.store.fail(ident, owner)

    async def checked_artifacts(self, profile, request, result):
        ids = result.get('artifactIds')
        if (not isinstance(result.get('text'), str) or not result['text'].strip()
                or len(result['text']) > 65536 or 'MEDIA:' in result['text']
                or not isinstance(ids, list) or len(ids) != len(request['requiredMimeTypes'])
                or len(set(ids)) != len(ids)):
            raise ValueError('Incomplete operator assignment result')
        kinds = []
        for ident in ids:
            if str(uuid.UUID(ident)) != ident:
                raise ValueError('Invalid operator assignment artifact')
            metadata, stream = await receive_artifact({'uid': profile['uid'], 'artifactId': ident})
            try:
                if metadata['artifactId'] != ident or metadata['sizeBytes'] <= 0:
                    raise ValueError('Incomplete operator assignment artifact')
                kind = metadata['mimeType']
                if kind == 'application/octet-stream':
                    office = OFFICE_DOCUMENTS.get(PurePath(metadata['filename']).suffix.lower())
                    if office is not None and office[0] in request['requiredMimeTypes']:
                        kind = self.checked_office_type(office, stream)
                kinds.append(kind)
            finally:
                stream.close()
        if sorted(kinds) != sorted(request['requiredMimeTypes']):
            raise ValueError('Incorrect operator assignment artifacts')
        return [{'artifact': {'artifact_id': ident}, 'presentation': 'document', 'caption': ''} for ident in ids]

    @staticmethod
    def checked_office_type(office, stream):
        """Recognize a published Office document using its OPC manifest and main part."""
        mime, main_part, main_mime = office
        with ZipFile(stream) as archive:
            types = archive.getinfo('[Content_Types].xml')
            if types.file_size > 64 * 1024 or archive.getinfo(main_part).file_size <= 0:
                raise ValueError('Invalid Office document package')
            root = ElementTree.fromstring(archive.read(types))
            if root.tag != OFFICE_CONTENT_TYPES + 'Types' or not any(
                    part.get('PartName') == '/' + main_part and part.get('ContentType') == main_mime
                    for part in root.findall(OFFICE_CONTENT_TYPES + 'Override')):
                raise ValueError('Invalid Office document package')
        return mime

    @staticmethod
    def outbox_id(ident, part):
        return delivery_id(['operator-assignment', ident, part])

    async def approve(self, profile, route, metadata, owner, value, digest):
        ident, request, result = value['id'], value['request'], value['result']
        if (value['state'] != 'ready' or delivery_id(result) != digest
                or self.resolver._startup_held()
                or getattr(self.resolver.release_gate, 'operation', None) is not None):
            raise RpcError(-32602, 'Operator assignment is not ready')
        items = await self.checked_artifacts(profile, request, result)
        await self.check_target(profile, route, ident, request)
        metadata = {**metadata, 'telegram_reply_to_message_id': request['anchor']}
        chat = route[0]
        if items:
            items[0]['caption'] = result['text']
            action = 'send_file_set'
            payload = {'chat_id': chat, 'items': items, 'metadata': metadata, 'reply_to': request['anchor'],
                       'kind': 'single' if len(items) == 1 else 'album', 'fallback': False}
        else:
            action = 'send'
            payload = {'chat_id': chat, 'content': result['text'], 'reply_to': request['anchor'], 'metadata': metadata}
        db = self.resolver.ledger.db
        db.execute('BEGIN IMMEDIATE')
        try:
            if not self.store.approve(ident, owner, digest):
                raise ValueError('Operator assignment changed')
            self.resolver.reply_outbox.enqueue(self.outbox_id(ident, 'result'), owner,
                {'profile': profile, 'action': action, 'payload': payload,
                 'generation': request['chatGeneration'], 'operatorAssignmentId': ident})
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        await self.resolver.reply_outbox.flush_owner(owner)

    def cancel(self, ident, owner):
        db = self.resolver.ledger.db
        db.execute('BEGIN IMMEDIATE')
        try:
            cancelled = self.store.cancel(ident, owner)
            if cancelled:
                self.resolver.reply_outbox.cancel_pending(self.outbox_id(ident, 'result'), owner)
            db.execute('COMMIT')
            return cancelled
        except BaseException:
            db.execute('ROLLBACK')
            raise

    async def check_target(self, profile, route, ident, request):
        if self.resolver._startup_held() or getattr(self.resolver.release_gate, 'operation', None) is not None:
            raise DeliveryDeferred('Operator assignment waits for RELEASE')
        peer = await self.resolver._bridge(profile).connect()
        checked = await peer.call('operator.assignment', {
            **self.worker_params(ident, profile['userId'], request), 'checkOnly': True}, timeout=15)
        if checked.get('state') == 'busy':
            raise DeliveryDeferred('Operator assignment waits for its worker')
        if checked.get('state') != 'validated':
            raise PermissionError('Operator assignment session changed')
        active = await self.resolver._account(profile, route[0])
        if (active.get('role'), active.get('generation')) != (request['role'], request['authGeneration']):
            raise PermissionError('Operator assignment authorization changed')
        self.resolver._chat_generation(profile, route, request['chatGeneration'])
        if self.resolver._startup_held() or getattr(self.resolver.release_gate, 'operation', None) is not None:
            raise DeliveryDeferred('Operator assignment waits for RELEASE')
        if not self.resolver.ledger.owns(profile, route, request['anchor'], outgoing=False):
            raise PermissionError('Operator assignment route unavailable')

    async def check_delivery(self, body, route):
        ident, profile, payload = body['operatorAssignmentId'], body['profile'], body['payload']
        owner = self.resolver.ledger.owner(profile)
        value = self.store.read(ident, owner)
        if value is None or value['state'] != 'approved':
            raise PermissionError('Operator assignment is not approved for delivery')
        request = value['request']
        if ((request['chat'], request['thread']) != route or payload.get('reply_to') != request['anchor']
                or body['generation'] != request['chatGeneration']):
            raise PermissionError('Operator assignment route changed')
        await self.check_target(profile, route, ident, request)

    def begin_delivery(self, body, begin_attempt):
        ident = body['operatorAssignmentId']
        owner = self.resolver.ledger.owner(body['profile'])
        db = self.resolver.ledger.db
        db.execute('BEGIN IMMEDIATE')
        try:
            if not self.store.sending(ident, owner):
                raise PermissionError('Operator assignment no longer approved')
            begin_attempt()
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise

    def status(self, ident, owner):
        value = self.store.read(ident, owner)
        if value['state'] in ('approved', 'sending'):
            receipt = self.resolver.reply_outbox.result(self.outbox_id(ident, 'result'))
            if receipt and (receipt.get('success') is True and receipt.get('message_id')
                            or receipt.get('retryable') is False):
                self.store.complete(ident, owner, receipt)
                value = self.store.read(ident, owner)
        return {'state': value['state'], 'result': value['result'], 'receipt': value['receipt'],
                'resultDigest': delivery_id(value['result']) if value['result'] is not None else None}
