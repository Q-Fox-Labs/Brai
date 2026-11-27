# ABOUTME: Принимает события одного владельца и запускает его native Hermes gateway.
# ABOUTME: Не принимает соединения от UID пользователя и не содержит Telegram token.
"""Жизненный цикл worker; политика UID, сети и файлов задаётся оператором."""
import argparse
import asyncio
import errno
import json
import logging
import os
import re
import signal
import socket
import stat
import sys
import time
from types import SimpleNamespace
import uuid
from datetime import datetime
from contextlib import contextmanager
from pathlib import Path
from .adapter import make_adapter
from .ipc import MAX_FRAME, Peer, RpcError, peer_uid


class Worker:
    """Один профиль и единственный подтверждённый ingress на соединение."""
    def __init__(self, ingress_uid, user_id, telegram_id, publish_file, runner_factory=None):
        if type(ingress_uid) is not int or ingress_uid < 0 or ingress_uid == os.getuid():
            raise ValueError('ingress UID must differ from worker UID')
        if not isinstance(user_id, str) or not user_id or not isinstance(telegram_id, str) or not telegram_id.isdecimal():
            raise ValueError('owner required')
        self.ingress_uid, self.user_id, self.telegram_id, self.publish_file = ingress_uid, user_id, telegram_id, publish_file
        self.runner_factory = runner_factory
        self.peer = self.runner = self.adapter = None
        self.active = {}
        self.operator_lock = asyncio.Lock()
        self.operator_route = None
        self.operator_run = None
        self.typing = {}
        self.turn_scopes = {}
        self.recovery_scopes = {}
        self.tools_ready = False
        self.tools_lock = asyncio.Lock()
        self.operational = asyncio.Event()
        self.lifecycle_task = None
        self.policy_task = None
        self.cold_recovery_task = None
        self.policy_ready = asyncio.Event()
        self.policy_ready.set()
        self.policy_error = None
        self.policy_stopping = False
        self.activation = asyncio.Event()
        self.exited = asyncio.Event()
        self.exit_code = None
        self.lifecycle_error = None
        self.chat_states = {}
        self.chat_snapshot_ready = False
        self.chat_stopping = {}
        self.chat_dispatches = {}
        self.chat_interactive = {}
        self.chat_locks = {}
        self.browser = None
        self.browser_recoveries = set()
        self.peer_lock = asyncio.Lock()
        self.runtime_stop_lock = asyncio.Lock()
        self.runtime_stopped = False
        self.peer_draining = False
        self.peer_released = asyncio.Event()
        self.peer_released.set()
        self.delivery_journal = None
        self.delivery_lock = asyncio.Lock()
        self.output_lock = asyncio.Lock()
        from .release_native import NativeRelease
        self.release = NativeRelease(self)

    def browser_working(self):
        tasks = getattr(self.adapter, '_session_tasks', {}).values()
        if (any(self.chat_dispatches.values()) or any(self.chat_interactive.values())
                or self.browser_recoveries or any(not task.done() for task in tasks)
                or any(not task.done() for task in self.release.tasks)):
            return True
        if not self.activation.is_set():
            return False
        from cron.scheduler import get_running_job_ids
        from tools.async_delegation import active_count
        return bool(get_running_job_ids() or active_count()
                    or any(getattr(self.runner, '_running_agents', {}).values()))

    def browser_task_ended(self):
        if self.browser is not None:
            self.browser.task_ended()

    async def serve_connection(self, reader, writer):
        """Разрешить health-наблюдателя без захвата основного duplex канала."""
        if peer_uid(writer) != self.ingress_uid:
            writer.close()
            await writer.wait_closed()
            return
        claimed = asyncio.Event()
        peer = None

        async def claim():
            async with self.peer_lock:
                if self.peer is peer:
                    return
                if self.peer is not None and self.peer.closed:
                    await self.peer_released.wait()
                if self.peer is not None:
                    raise RpcError(-32602, 'Operational health requires the active ingress channel')
                self.peer = peer
                self.peer_released.clear()
                try:
                    await self.start(peer)
                except BaseException as error:
                    if isinstance(error, Exception):
                        self.lifecycle_error = error
                        self.exit_code = 1
                        self.exited.set()
                        diagnostic = getattr(error, 'diagnostic', None)
                        diagnostic = diagnostic if isinstance(diagnostic, dict) else {}
                        reason, stage = diagnostic.get('reason', ''), diagnostic.get('stage', '')
                        logging.getLogger(__name__).error(
                            'HERMES_WORKER_STARTUP_FAILED type=%s reason=%s stage=%s',
                            type(error).__name__,
                            reason if isinstance(reason, str) and re.fullmatch('[A-Z_]+', reason) else 'UNKNOWN',
                            stage if isinstance(stage, str) and re.fullmatch('[a-z_]+', stage) else 'bootstrap')
                    claimed.set()
                    raise
                claimed.set()

        async def check_health(require_tools=False):
            if type(require_tools) is not bool:
                raise RpcError(-32602, 'Invalid health check')
            if require_tools:
                await claim()
            return await self.health(require_tools=require_tools)

        def primary(method):
            async def call(**params):
                if self.peer is not peer:
                    raise RpcError(-32601, 'Method not found')
                return await method(**params)
            return call

        peer = Peer(reader, writer, {'health': check_health, 'dispatch': primary(self.dispatch),
                    'dispatch.status': primary(self.dispatch_status), 'outbox.flush': primary(self.flush_outputs),
                    'operator.assignment': primary(self.run_operator_assignment),
                    'operator.assignment.cancel': primary(self.cancel_operator_assignment),
                    'cancel': primary(self.cancel), 'interactive': primary(self.interactive),
                    'chat_pause': primary(self.chat_pause), 'release.begin': primary(self.release.begin), 'release.try': primary(self.release.try_hold),
                    'release.try_status': primary(self.release.try_status), 'release.reject_attempt': primary(self.release.reject_attempt),
                    'release.status': primary(self.release.status), 'release.resume': primary(self.release.resume)})
        reading = asyncio.create_task(peer.run())
        claimed_wait = asyncio.create_task(claimed.wait())
        try:
            await asyncio.wait((reading, claimed_wait), return_when=asyncio.FIRST_COMPLETED)
            if claimed.is_set() and self.peer is peer and self.lifecycle_task is not None:
                await asyncio.wait((reading, self.lifecycle_task), return_when=asyncio.FIRST_COMPLETED)
        except Exception as error:
            self.lifecycle_error = error
            self.exit_code = 1
            self.exited.set()
        finally:
            claimed_wait.cancel()
            await asyncio.gather(claimed_wait, return_exceptions=True)
            if self.peer is peer:
                # Only a peer EOF that precedes native exit is a clean handoff.
                # A native lifecycle that already ended must keep its exit verdict.
                self.peer_draining = (reading.done() and not reading.cancelled()
                                      and self.lifecycle_task is not None
                                      and not self.lifecycle_task.done())
                try:
                    await self.stop_runtime()
                except Exception as error:
                    self.lifecycle_error = error
                    self.exit_code = 1
                    self.exited.set()
                    raise
                finally:
                    self.peer_draining = False
                    if not reading.done():
                        reading.cancel()
                    await asyncio.gather(reading, return_exceptions=True)
                    for task in list(self.typing.values()):
                        task.cancel()
                    await asyncio.gather(*self.typing.values(), return_exceptions=True)
                    self.typing.clear()
                    self.active.clear()
                    self.turn_scopes.clear()
                    self.recovery_scopes.clear()
                    self.operational.clear()
                    self.adapter = self.runner = self.peer = None
                    self.peer_released.set()
            elif not reading.done():
                reading.cancel()
                await asyncio.gather(reading, return_exceptions=True)

    async def start(self, peer):
        """Подготовить bootstrap; полный native startup ждёт active Auth."""
        if self.exited.is_set():
            raise RuntimeError('Worker lifecycle already exited')
        self.exit_code = None
        self.lifecycle_error = None
        self.runtime_stopped = False
        os.environ['HERMES_EXEC_ASK'] = '1'
        managed_stt = False
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            self._install_telegram_profile()
            from .native_policy import install
            managed_stt = install(cold_start=self.release.cold_start)
        from gateway.run import GatewayRunner
        from gateway.config import Platform, PlatformConfig
        self.runner = self.runner_factory() if self.runner_factory else GatewayRunner()
        self.release.install(self.runner)
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            from .native_policy import revalidate_startup
            revalidate_startup()
        if managed_stt:
            from .native_policy import install_telegram_audio_input
            install_telegram_audio_input(self.runner, Platform.TELEGRAM)
            self.runner.config.stt_enabled = True
        if getattr(self.runner.config, 'multiplex_profiles', False):
            raise RuntimeError('worker cannot multiplex profiles')
        self.tools_ready = False
        self.policy_stopping = False
        self.policy_error = None
        self.policy_ready.set()
        self.operational.clear()
        self.activation.clear()
        configured = getattr(self.runner.config, 'platforms', {})
        config = configured.get(Platform.TELEGRAM) or PlatformConfig()
        config.enabled = True
        self.runner.config.platforms = {Platform.TELEGRAM: config}
        self.adapter = make_adapter(config, Platform.TELEGRAM, peer, self.publish_file)
        self.adapter.gateway_runner = self.runner
        self.adapter._brai_delivery_journal = self.delivery_journal
        if self.browser is not None:
            resume = getattr(self.runner, '_run_startup_resume_event', None)
            if callable(resume):
                async def resume_with_browser(*args, **kwargs):
                    task = asyncio.current_task()
                    self.browser_recoveries.add(task)
                    try:
                        return await resume(*args, **kwargs)
                    finally:
                        self.browser_recoveries.discard(task)
                        self.browser_task_ended()
                self.runner._run_startup_resume_event = resume_with_browser
        self.runner._is_user_authorized_for_source = lambda source, **kwargs: (
            source.platform == Platform.TELEGRAM and str(source.user_id) == self.telegram_id
            and not source.is_bot)
        self.runner._make_adapter_auth_check = lambda platform, profile_name=None: (
            lambda user_id, *args, **kwargs: platform == Platform.TELEGRAM
            and (str(user_id) == self.telegram_id or self.adapter.is_interactive_actor(user_id)))
        self.runner._brai_identity_recovery_allowed = lambda source: self.route_allowed(source, recovery=True)
        self._install_failure_recovery(self.runner)
        self._install_restart_recovery(self.runner)
        self.runner._brai_return_notice_state = self.return_notice_state
        self.runner._brai_shutdown_notice_scope = self.shutdown_notice_scope
        self.runner._brai_consent_generation = lambda source: (
            self.chat_states.get(self._chat_route(source), {}).get('generation', 0)
            if self.route_allowed(source) else -1)
        self.runner._brai_consent_route_current = lambda event: (
            self.route_allowed(event.source) and
            getattr(event, '_brai_chat_generation', 0) ==
            self.chat_states.get(self._chat_route(event.source), {}).get('generation', 0))
        original_admit = getattr(self.runner, '_hm_admit_event', None)
        if callable(original_admit):
            async def paused_admit(event):
                def allowed():
                    state = self.chat_states.get(self._chat_route(event.source), {})
                    recovered = (getattr(event, 'metadata', None) or {}).get('recovered')
                    return (self.route_allowed(event.source, recovery=bool(recovered or getattr(event, 'internal', False)))
                        and getattr(event, '_brai_chat_generation', state.get('generation', 0)) == state.get('generation', 0))
                if not allowed():
                    return None
                admitted = await original_admit(event)
                if not allowed():
                    return None
                return admitted
            self.runner._hm_admit_event = paused_admit
        # AIDEV-NOTE: Native сохраняет wiring/connect/recovery. Подменяется только transport.
        def adapter_factory(platform, platform_config):
            if platform != Platform.TELEGRAM or peer.closed:
                raise RuntimeError('Worker transport unavailable')
            return self.adapter
        self.runner._instantiate_adapter = adapter_factory
        self.lifecycle_task = asyncio.create_task(self._run_lifecycle())

    def _install_failure_recovery(self, runner):
        """Сохранить технически прерванный ход до его закрытия и подключить штатный watcher."""
        original = getattr(runner, '_hmwa_shape_agent_response', None)
        if not callable(original):
            return

        resolve_session = getattr(runner, '_hmwa_resolve_session', None)
        if callable(resolve_session):
            async def resolve_preserving_actor(event, source):
                actor = getattr(source, '_brai_actor_id', None)
                result = await resolve_session(event, source)
                if actor is not None and result is not None:
                    result[0]._brai_actor_id = actor
                    event.source._brai_actor_id = actor
                return result
            runner._hmwa_resolve_session = resolve_preserving_actor

        system_prompt = getattr(runner, '_get_system_prompt_for_channel', None)
        if callable(system_prompt):
            def assignment_prompt(platform, chat_id, *, thread_id=None, parent_id=None):
                from .scope import operator_assignment
                prompt = system_prompt(platform, chat_id, thread_id=thread_id, parent_id=parent_id)
                assignment = operator_assignment.get()
                if (assignment is not None and getattr(assignment, 'public_facts', None)
                        and getattr(platform, 'value', platform) == 'telegram'
                        and self._chat_route(SimpleNamespace(chat_id=chat_id, thread_id=thread_id)) == assignment.route):
                    prompt = (prompt + '\n\nVerified public service facts from the deployment operator for this assignment:\n'
                              + assignment.public_facts).strip()
                return prompt
            runner._get_system_prompt_for_channel = assignment_prompt

        async def remember(source, session_key):
            if session_key and self.route_allowed(source, recovery=True):
                from .scope import input_delivery
                input_id = input_delivery.get()
                if self.delivery_journal is not None and input_id is not None:
                    generation = self.chat_states.get(self._chat_route(source), {}).get('generation', 0)
                    self.delivery_journal.save_continuation(session_key, input_id, generation)
                await runner.async_session_store.mark_resume_pending(session_key, 'brai_technical_failure')
                logging.getLogger(__name__).info(
                    'HERMES_FAILED_TURN_RECOVERY_MARKED session=%s binding=%s',
                    session_key, input_id is not None and self.delivery_journal is not None)

        async def shape(result, source, history, entry, session_key, *args, **kwargs):
            from .scope import operator_assignment
            assignment = operator_assignment.get()
            if assignment is not None:
                value = await original(result, source, history, entry, session_key, *args, **kwargs)
                if (session_key == assignment.session_key and isinstance(result, dict)
                        and result.get('completed') is not False
                        and not any(result.get(key) for key in ('failed', 'partial', 'error',
                                                               'interrupted', 'guardrail'))
                        and not value[1] and isinstance(value[0], str) and value[0].strip()):
                    groups = result.get('fileSets', [])
                    if not groups and 'MEDIA:' in value[0]:
                        import brai_files
                        # The gateway result can omit the file envelope while retaining prepared media paths.
                        groups = brai_files.result_envelope({'final_response': value[0]},
                                                           SimpleNamespace(platform='telegram')).get('fileSets', [])
                    artifacts = [item['file']['artifactId'] for group in groups
                                 for item in group['items']]
                    text = self.adapter.strip_media_directives_for_display(value[0]) if artifacts else value[0]
                    assignment.result = {'text': text, 'artifactIds': list(dict.fromkeys(artifacts))}
                return value
            guardrail = result.get('guardrail') if isinstance(result, dict) else None
            review_unavailable = isinstance(guardrail, dict) and guardrail.get('code') == 'brai_review_unavailable'
            if (isinstance(result, dict) and not result.get('interrupted')
                    and (result.get('failed') or (result.get('partial') and result.get('error')))):
                await remember(source, session_key)
            value = await original(result, source, history, entry, session_key, *args, **kwargs)
            if review_unavailable and not result.get('interrupted'):
                # Native regards a controlled guardrail halt as complete; restore the marker afterwards.
                await remember(source, session_key)
            return value

        runner._hmwa_shape_agent_response = shape
        original_error = getattr(runner, '_hmwa_agent_error_reply', None)
        if callable(original_error):
            async def error_reply(error, event, source, entry, session_key, prepared):
                from .scope import continuation_turn, operator_assignment
                if operator_assignment.get() is not None:
                    return None
                value = await original_error(error, event, source, entry, session_key, prepared)
                await remember(source, session_key)
                return None if continuation_turn.get() else value
            runner._hmwa_agent_error_reply = error_reply
        original_deliver = getattr(runner, '_hmwa_deliver_turn_response', None)
        if callable(original_deliver):
            original_voice_check = getattr(runner, '_should_send_voice_reply', None)
            if callable(original_voice_check):
                def voice_check(event, *args, **kwargs):
                    import brai_files
                    if getattr(event, '_brai_voice_done', False) or brai_files.reply_mode_for_event(event) in ('video_note', 'off'):
                        return False
                    return original_voice_check(event, *args, **kwargs)
                runner._should_send_voice_reply = voice_check
            async def deliver(event, source, entry, session_key, generation, result, *args, **kwargs):
                from .scope import continuation_turn, input_delivery, operator_assignment, prepared_response
                assignment = operator_assignment.get()
                if assignment is not None:
                    assignment.completed = (session_key == assignment.session_key
                                            and entry.session_id == assignment.session_id)
                    return None
                guardrail = result.get('guardrail') if isinstance(result, dict) else None
                event._brai_successful_turn = (isinstance(result, dict)
                    and not any(result.get(key) for key in ('failed', 'partial', 'error', 'interrupted'))
                    and result.get('completed') is not False
                    and not (isinstance(guardrail, dict) and guardrail.get('code') == 'brai_review_unavailable'))
                current = getattr(runner, '_is_session_run_current', None)
                if event._brai_successful_turn and (not callable(current) or current(session_key, generation)):
                    import brai_files
                    brai_files.commit_reply_mode(result, event)
                if (continuation_turn.get() and isinstance(result, dict)
                        and (result.get('failed') or (result.get('partial') and result.get('error'))
                             or (isinstance(guardrail, dict)
                             and guardrail.get('code') == 'brai_review_unavailable'))):
                    return None
                response = args[1] if len(args) > 1 else kwargs.get('response')
                intentional_silence = args[3] if len(args) > 3 else kwargs.get('_intentional_silence', False)
                from gateway.warning_notifications import diagnostic_wake_muted
                ident = input_delivery.get()
                adapter = runner._delivery_adapter_for(source)
                streaming_media = []
                footer = (args[2] if len(args) > 2 else kwargs.get('_footer_line')) or None
                if (event._brai_successful_turn and result.get('already_sent')
                        and not result.get('media_already_delivered') and isinstance(response, str)
                        and adapter is not None):
                    media, _ = adapter.extract_media(response)
                    streaming_media = adapter.filter_media_delivery_paths(media)
                streaming_result = bool(result.get('already_sent') and (streaming_media or footer))
                if (event._brai_successful_turn and (not result.get('already_sent') or streaming_result)
                        and not intentional_silence and not diagnostic_wake_muted(event)
                        and isinstance(response, str) and (response or footer)
                        and ident is not None and self.delivery_journal is not None
                        and adapter is not None and callable(getattr(adapter, '_preview_prepared_response', None))
                        and callable(getattr(source, 'to_dict', None))):
                    fields = {key: getattr(event, key, None) for key in
                        ('message_id', 'reply_to_message_id', 'reply_anchor_override', 'ledger_message_id')}
                    kind = getattr(event, 'message_type', None)
                    fields['message_type'] = getattr(kind, 'value', kind)
                    voice = getattr(runner, '_should_send_voice_reply', None)
                    messages = args[0] if args else kwargs.get('agent_messages', [])
                    streamed = bool(adapter and getattr(adapter, '_streaming_tts_turn_completed',
                        lambda *_args, **_kwargs: False)(session_key, generation))
                    fields['auto_voice'] = 'yes' if (not streamed and callable(voice)
                        and voice(event, response, messages, already_sent=bool(result.get('already_sent')))) else 'no'
                    if streaming_result:
                        fields['already_streamed'] = 'yes'
                        fields['stream_footer'] = footer
                        fields['skip_stream_media'] = 'yes' if not streaming_media else 'no'
                    saved_response = response or footer
                    preview = await adapter._preview_prepared_response(saved_response, event, session_key,
                        streamed=streaming_result, media=streaming_media)
                    saved_source = source.to_dict()
                    if getattr(source, '_brai_actor_id', None):
                        saved_source['brai_actor_id'] = source._brai_actor_id
                    self.delivery_journal.save_response(session_key, ident, saved_response, fields, saved_source, preview)
                    prepared_response.set((session_key, ident, saved_response))
                    if streaming_result:
                        event._brai_streamed_response = True
                        event._brai_stream_footer = fields['stream_footer']
                        event._brai_skip_stream_media = fields['skip_stream_media'] == 'yes'
                        if fields['auto_voice'] == 'yes':
                            await runner._send_voice_reply(event, response)
                            event._brai_voice_done = True
                        extracted = await adapter._extract_response_content(saved_response, event, session_key,
                            is_ephemeral_response=False)
                        await adapter._deliver_attachments(event, extracted, runner._event_thread_metadata(event, source),
                            anything_sent=True, record_delivery=lambda _result: None)
                        result = {**result, 'media_already_delivered': True}
                        if len(args) > 2:
                            args = (*args[:2], '', *args[3:])
                        else:
                            kwargs['_footer_line'] = ''
                return await original_deliver(event, source, entry, session_key, generation, result, *args, **kwargs)
            runner._hmwa_deliver_turn_response = deliver
        runner._brai_retry_failed_sessions = self._retry_failed_sessions
        mark_active = getattr(runner, '_mark_durable_active_turn', None)
        if callable(mark_active):
            async def mark_visible_turn(event, session_key):
                from .scope import operator_assignment
                if operator_assignment.get() is None:
                    return await mark_active(event, session_key)
                return False
            runner._mark_durable_active_turn = mark_visible_turn
        original_resume = getattr(runner, '_run_startup_resume_event', None)
        if callable(original_resume):
            async def resume(adapter, event, session_key):
                if not await self._operator_turn_held(session_key):
                    return await original_resume(adapter, event, session_key)
                from gateway.run import _AGENT_PENDING_SENTINEL
                try:
                    await runner.async_session_store.clear_resume_pending(session_key)
                finally:
                    state = runner._peek_session_state(session_key)
                    if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                        runner._release_running_agent_state(session_key)
            runner._run_startup_resume_event = resume
        self.operator_hooks_ready = all(callable(hook) for hook in
            (original, original_error, original_deliver, mark_active, original_resume))

    async def _operator_turn_held(self, session_key):
        home = os.environ.get('HERMES_HOME', '')
        if self.delivery_journal is None and home.startswith('/') and (Path(home) / 'identity-delivery.sqlite3').is_file():
            self._enable_delivery()
        if self.delivery_journal is None:
            return False
        session_id = self.delivery_journal.operator_session_id(session_key)
        if session_id is None:
            return False
        entry = await self.runner.async_session_store.lookup_by_session_key(session_key)
        return entry is not None and entry.session_id == session_id

    async def run_operator_assignment(self, owner, operationId, sessionKey, sessionId, chat, thread,
                                      chatGeneration, instructions, checkOnly=False, publicFacts=None):
        """Run the same authorized native injection and keep the final answer private."""
        if (owner != self.user_id or not isinstance(operationId, str)
                or str(uuid.UUID(operationId)) != operationId
                or not isinstance(sessionKey, str) or not 1 <= len(sessionKey) <= 512
                or not isinstance(sessionId, str) or not 1 <= len(sessionId) <= 256
                or not isinstance(chat, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', chat)
                or not isinstance(thread, str)
                or type(checkOnly) is not bool
                or type(chatGeneration) is not int or chatGeneration < 0
                or not isinstance(instructions, str) or not instructions.strip()
                or publicFacts is not None and (not isinstance(publicFacts, str) or not publicFacts.strip())
                or len(instructions.encode()) + len((publicFacts or '').encode()) > 48000):
            raise RpcError(-32602, 'Invalid operator assignment')
        if self.operator_lock.locked():
            return {'state': 'busy'}
        async with self.operator_lock:
            if (not self.operational.is_set() or self.release.operation is not None
                    or self.policy_stopping or any(self.chat_dispatches.values())
                    or any(not task.done() for task in self.adapter._session_tasks.values())):
                return {'state': 'busy'}
            route = (chat, thread)
            if not checkOnly:
                self.operator_route = route
                self.operator_run = operationId, asyncio.current_task()
            try:
                return await self._run_operator_session(operationId, sessionKey, sessionId, route,
                                                        chatGeneration, instructions, checkOnly, publicFacts)
            finally:
                self.operator_run = None
                self.operator_route = None

    async def _run_operator_session(self, ident, key, session_id, route, generation, instructions, check_only, public_facts):
        from .scope import delivery_scope, input_delivery, operator_assignment
        runner, adapter = self.runner, self.adapter
        entry = await runner.async_session_store.lookup_by_session_key(key)
        if self.release.operation is not None or self.policy_stopping:
            return {'state': 'busy'}
        if entry is None or entry.origin is None or entry.session_id != session_id:
            return {'state': 'session_changed'}
        source = runner._restored_source(entry)

        def can_start():
            task = adapter._session_tasks.get(key)
            return (self.release.operation is None and not self.policy_stopping
                    and not self.chat_dispatches.get(route) and not self.chat_interactive.get(route)
                    and (task is None or task.done()) and self.route_allowed(source, recovery=True)
                    and self.chat_states.get(route, {}).get('generation', 0) == generation)

        if (self._chat_route(source) != route or str(getattr(source, 'user_id', '') or '') != self.telegram_id
                or not can_start()):
            return {'state': 'route_changed'}
        if check_only:
            authorized = runner._plugin_injection_authorized(source, plugin_id='brai-telegram', target=key)
            return {'state': 'validated' if authorized else 'route_changed'}
        if entry.resume_pending or getattr(entry, 'active_turn_token', None):
            return {'state': 'busy'}
        if not getattr(self, 'operator_hooks_ready', False):
            return {'state': 'unsupported'}
        self._enable_delivery()
        self.delivery_journal.hold_operator_turn(key, session_id, ident)
        assignment = SimpleNamespace(session_key=key, session_id=session_id, can_start=can_start,
                                     route=route, public_facts=public_facts, completed=False, result=None)
        assignment_token = operator_assignment.set(assignment)
        scope_token = delivery_scope.set('operator-assignment:' + ident)
        source_token = input_delivery.set(None)
        try:
            adapter.bind_source(source)
            accepted = await runner._dispatch_plugin_message_injection(
                session_key=key, content=instructions, plugin_id='brai-telegram')
            task = adapter._session_tasks.get(key)
            if not accepted or task is None:
                return {'state': 'not_started'}
            await task
            if not assignment.completed or assignment.result is None:
                return {'state': 'incomplete'}
            return {'state': 'ready', 'result': assignment.result}
        finally:
            input_delivery.reset(source_token)
            delivery_scope.reset(scope_token)
            operator_assignment.reset(assignment_token)

    async def cancel_operator_assignment(self, owner, operationId):
        if owner != self.user_id or not isinstance(operationId, str) or str(uuid.UUID(operationId)) != operationId:
            raise RpcError(-32602, 'Invalid operator assignment')
        active = self.operator_run
        if active is None or active[0] != operationId:
            return {'state': 'inactive'}
        active[1].cancel()
        await asyncio.gather(active[1], return_exceptions=True)
        return {'state': 'stopped'}

    def _install_restart_recovery(self, runner):
        """Привязать начатый native ход к входу и восстановить его маршрут после рестарта."""
        handle = getattr(runner, '_handle_message_with_agent', None)
        if callable(handle):
            async def handle_saved_response(event, source, session_key, *args, **kwargs):
                response = getattr(event, '_brai_ready_response', None)
                if response is not None:
                    from .scope import input_delivery, prepared_response
                    prepared_response.set((session_key, input_delivery.get(), response))
                    event._brai_successful_turn = True
                    if getattr(event, '_brai_auto_voice', False):
                        await runner._send_voice_reply(event, response)
                    return response
                return await handle(event, source, session_key, *args, **kwargs)
            runner._handle_message_with_agent = handle_saved_response
        mark = getattr(runner, '_mark_durable_active_turn', None)
        if callable(mark):
            async def mark_bound(event, session_key):
                from .scope import input_delivery
                input_id = input_delivery.get()
                if input_id is not None and self.delivery_journal is not None:
                    generation = getattr(event, '_brai_chat_generation', None)
                    if generation is None:
                        binding = self.delivery_journal.continuation(session_key)
                        generation = binding['chat_generation'] if binding else None
                    if type(generation) is not int:
                        raise ValueError('CONTINUATION_GENERATION_UNKNOWN')
                    self.delivery_journal.save_continuation(session_key, input_id, generation)
                elif self.delivery_journal is not None:
                    self.delivery_journal.clear_continuation(session_key)
                return await mark(event, session_key)
            runner._mark_durable_active_turn = mark_bound
        resume = getattr(runner, '_run_startup_resume_event', None)
        if not callable(resume):
            return

        async def resume_bound(adapter, event, session_key):
            from .scope import input_delivery, delivery_scope, continuation_turn
            from gateway.run import _AGENT_PENDING_SENTINEL
            if self.delivery_journal is None and os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
                self._enable_delivery()
            current_binding = self.delivery_journal.continuation(session_key) if self.delivery_journal else None
            detached = getattr(event, '_brai_detached_input', None)
            candidate = detached or (current_binding['input_id'] if current_binding else None)
            saved = self.delivery_journal.prepared_response(session_key, candidate) if candidate and self.delivery_journal else None
            binding = ({'input_id': saved['input_id'], 'chat_generation': saved['chat_generation'],
                        'ready_response': saved['response'], 'response_event': saved['event']} if saved else current_binding)
            route = self._chat_route(event.source)
            if (binding is None or not self.route_allowed(event.source, recovery=True)
                    or binding['chat_generation'] != self.chat_states.get(route, {}).get('generation', 0)):
                state = runner._peek_session_state(session_key)
                if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                    runner._release_running_agent_state(session_key)
                logging.getLogger(__name__).warning('HERMES_RECOVERY_INPUT_UNAVAILABLE session=%s', session_key)
                return
            if saved and saved['phase'] == 'prepared_enqueued':
                try:
                    if current_binding and current_binding['input_id'] == saved['input_id']:
                        await runner.async_session_store.clear_resume_pending(session_key)
                    self.delivery_journal.clear_response(session_key, saved['input_id'], saved['response'])
                finally:
                    state = runner._peek_session_state(session_key)
                    if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                        runner._release_running_agent_state(session_key)
                return
            if binding.get('ready_output'):
                try:
                    await runner.async_session_store.clear_resume_pending(session_key)
                finally:
                    state = runner._peek_session_state(session_key)
                    if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                        runner._release_running_agent_state(session_key)
                return
            try:
                if self.peer is None or self.peer.closed:
                    raise ConnectionError('Ingress unavailable')
                authorized = await self.peer.call('recovery.check', {'input_delivery_id': binding['input_id'],
                    'chat_id': route[0], 'thread_id': str(getattr(event.source, 'thread_id', None) or '')})
                if (authorized != {'allowed': True} or not self.route_allowed(event.source, recovery=True)
                        or binding['chat_generation'] != self.chat_states.get(route, {}).get('generation', 0)):
                    raise PermissionError('Recovery authorization changed')
            except (OSError, ConnectionError, TimeoutError, RpcError, PermissionError):
                state = runner._peek_session_state(session_key)
                if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                    runner._release_running_agent_state(session_key)
                logging.getLogger(__name__).warning('HERMES_RECOVERY_AUTH_UNAVAILABLE session=%s', session_key)
                return
            except BaseException:
                state = runner._peek_session_state(session_key)
                if state is not None and state.turn.agent is _AGENT_PENDING_SENTINEL:
                    runner._release_running_agent_state(session_key)
                raise
            event._brai_chat_generation = binding['chat_generation']
            if 'ready_response' in binding:
                event._brai_ready_response = binding['ready_response']
                for name, value in binding.get('response_event', {}).items():
                    if name == 'message_type' and value is not None:
                        from gateway.platforms.event import MessageType
                        event.message_type = MessageType(value)
                    elif name == 'auto_voice':
                        event._brai_auto_voice = value == 'yes'
                    elif name == 'already_streamed':
                        event._brai_streamed_response = value == 'yes'
                    elif name == 'stream_footer':
                        event._brai_stream_footer = value
                    elif name == 'skip_stream_media':
                        event._brai_skip_stream_media = value == 'yes'
                    else:
                        setattr(event, name, value)
            source_token = input_delivery.set(binding['input_id'])
            scope_token = delivery_scope.set(None)
            continuation_token = continuation_turn.set(True)
            current = asyncio.current_task()
            previous = self.recovery_scopes.get(session_key)
            self.recovery_scopes[session_key] = (current, binding['input_id'], event.source)
            try:
                adapter.bind_source(event.source)
                await resume(adapter, event, session_key)
            finally:
                if self.recovery_scopes.get(session_key, (None,))[0] is current:
                    if previous is None:
                        self.recovery_scopes.pop(session_key, None)
                    else:
                        self.recovery_scopes[session_key] = previous
                continuation_turn.reset(continuation_token)
                delivery_scope.reset(scope_token)
                input_delivery.reset(source_token)
        runner._run_startup_resume_event = resume_bound

    def _retry_prepared_responses(self, runner, adapter):
        """Возобновить готовые ответы, пережившие новый input или перезапуск worker."""
        from gateway.run import _AGENT_PENDING_SENTINEL
        from gateway.platforms.event import MessageEvent, MessageType
        from gateway.session import SessionSource
        for saved in self.delivery_journal.prepared_responses():
            key = saved['session_key']
            if not isinstance(saved.get('source'), dict):
                continue
            source = SessionSource.from_dict(saved['source'])
            actor = saved['source'].get('brai_actor_id')
            if isinstance(actor, str) and actor.isascii() and actor.isdecimal() and int(actor) > 0:
                source._brai_actor_id = actor
            task = getattr(adapter, '_session_tasks', {}).get(key)
            if ((task is not None and not task.done()) or runner._is_session_running(key)
                    or not self.route_allowed(source, recovery=True)
                    or saved['chat_generation'] != self.chat_states.get(self._chat_route(source), {}).get('generation', 0)
                    or not runner._resume_owner_authorized(key, source)
                    or runner._delivery_adapter_for(source) is not adapter):
                continue
            state = runner._session_state(key)
            state.turn.agent = _AGENT_PENDING_SENTINEL
            state.turn.started_ts = time.time()
            runner._persist_active_agents()
            event = MessageEvent(text='', message_type=MessageType.TEXT, source=source, internal=True)
            event._brai_detached_input = saved['input_id']
            runner._retain_background_task(asyncio.create_task(runner._run_startup_resume_event(adapter, event, key)))

    async def _retry_failed_sessions(self):
        """Вернуть сохранённые попытки в native turn после проверки владельца и маршрута."""
        runner, adapter, peer = self.runner, self.adapter, self.peer
        if (runner is None or adapter is None or peer is None or peer.closed
                or not self.operational.is_set() or self.policy_stopping):
            return
        try:
            with runner.session_store._lock:
                runner.session_store._ensure_loaded_locked()
                entries = [entry for entry in runner.session_store._entries.values()
                           if entry.resume_pending and not entry.suspended and entry.origin is not None
                           and entry.resume_reason in {'brai_technical_failure', 'restart_timeout', 'shutdown_timeout', 'restart_interrupted'}]
            if self.delivery_journal is None:
                home = os.environ.get('HERMES_HOME')
                if not entries and (not home or not (Path(home) / 'identity-delivery.sqlite3').exists()):
                    return
                self._enable_delivery()
            if not entries and not self.delivery_journal.prepared_responses():
                return
            from .native_policy import principal
            await asyncio.to_thread(principal)
            if (self.runner is not runner or self.adapter is not adapter or self.peer is not peer
                    or peer.closed or not self.operational.is_set() or self.policy_stopping):
                return
            from gateway.run import _AGENT_PENDING_SENTINEL
            from gateway.platforms.event import MessageEvent, MessageType
            for entry in entries:
                with runner.session_store._lock:
                    current = runner.session_store._entries.get(entry.session_key)
                    if (current is not entry or not entry.resume_pending or entry.suspended
                            or entry.resume_reason not in {'brai_technical_failure', 'restart_timeout', 'shutdown_timeout', 'restart_interrupted'}):
                        continue
                task = getattr(adapter, '_session_tasks', {}).get(entry.session_key)
                if (task is not None and not task.done()) or runner._is_session_running(entry.session_key):
                    continue
                source = runner._restored_source(entry)
                binding = self.delivery_journal.continuation(entry.session_key) if self.delivery_journal else None
                if (not self.route_allowed(source, recovery=True)
                        or binding is None
                        or binding['chat_generation'] != self.chat_states.get(self._chat_route(source), {}).get('generation', 0)
                        or not runner._resume_owner_authorized(entry.session_key, source)
                        or runner._delivery_adapter_for(source) is not adapter):
                    continue
                state = runner._session_state(entry.session_key)
                state.turn.agent = _AGENT_PENDING_SENTINEL
                state.turn.started_ts = time.time()
                runner._persist_active_agents()
                event = MessageEvent(text='', message_type=MessageType.TEXT, source=source, internal=True)
                runner._retain_background_task(asyncio.create_task(
                    self._resume_failed_turn(runner, adapter, event, entry.session_key, binding['input_id'])))
                logging.getLogger(__name__).info('HERMES_FAILED_TURN_RECOVERY_STARTED session=%s', entry.session_key)
            self._retry_prepared_responses(runner, adapter)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logging.getLogger(__name__).warning('HERMES_FAILED_TURN_RECOVERY_WAITING error=%s', type(error).__name__)

    async def _resume_failed_turn(self, runner, adapter, event, session_key, input_id):
        """Сохранить input для outbox и доверенный маршрут в дочерней native task."""
        from .scope import input_delivery, delivery_scope, continuation_turn
        source_token = input_delivery.set(input_id)
        scope_token = delivery_scope.set(None)
        continuation_token = continuation_turn.set(True)
        current = asyncio.current_task()
        self.recovery_scopes[session_key] = (current, input_id, event.source)
        try:
            adapter.bind_source(event.source)
            await runner._run_startup_resume_event(adapter, event, session_key)
        finally:
            if self.recovery_scopes.get(session_key, (None,))[0] is current:
                self.recovery_scopes.pop(session_key, None)
            continuation_turn.reset(continuation_token)
            delivery_scope.reset(scope_token)
            input_delivery.reset(source_token)

    def _install_telegram_profile(self):
        """Установить несекретный профиль до любого native plugin discovery."""
        os.environ['BRAI_IDENTITY_TELEGRAM_ID'] = self.telegram_id
        sys.modules.setdefault('_brai_identity_human', SimpleNamespace(
            telegram_id=self.telegram_id, game_core_enabled=False, attach=None))

    async def _startup_gate(self, runner):
        """Provisioning даёт только bootstrap; tools и recovery требуют active."""
        await self.activation.wait()
        from .tool_client import broker_call
        await asyncio.to_thread(broker_call, 'tools.list', {})
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            snapshot = await self.peer.call('chat_states', {'owner': self.user_id}, timeout=15)
            if (not isinstance(snapshot, dict) or snapshot.get('owner') != self.user_id
                    or not isinstance(snapshot.get('routes'), list) or len(snapshot['routes']) > 10000):
                raise RpcError(-32603, 'Chat snapshot unavailable')
            for state in snapshot['routes']:
                self._validate_chat_state(state)
                route = (state['chat'], state['thread'])
                old = self.chat_states.get(route)
                if old is None or old['generation'] <= state['generation']:
                    self.chat_states[route] = dict(state)
            self.chat_snapshot_ready = True

    async def _operational_ready(self, runner):
        """Подтвердить native startup вместе с MCP и scheduler."""
        from tools.registry import registry
        from .native_policy import guest_mode
        if not guest_mode() and registry.get_entry('mcp__brai__brai_login') is None:
            raise RpcError(-32603, 'Worker login tool unavailable')
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            human = sys.modules.get('_brai_identity_human')
            attach = getattr(human, 'attach', None)
            if not callable(attach):
                raise RpcError(-32603, 'Worker human plugin unavailable')
            await attach(self.adapter)
        if os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1':
            # Проверяется установленный файл профиля, который читает native GatewayRunner.
            from hermes_cli.config import load_config_readonly
            prompt = load_config_readonly().get('agent', {}).get('system_prompt', '')
            if not all(value in prompt for value in ('mcp__brai__dialogues_exchange',
                    'mcp__brai__dialogues_context_ack', 'context_request_id', 'finish')):
                raise RpcError(-32603, 'Worker Dialogues instruction unavailable')
            for name in ('mcp__brai__dialogues_exchange', 'mcp__brai__dialogues_context_ack'):
                if registry.get_entry(name) is None:
                    raise RpcError(-32603, 'Worker Dialogues tool unavailable')
        if guest_mode():
            from .native_policy import permitted, catalog_permitted
            if registry.get_entry('mcp__brai__create_text_file') is None or not catalog_permitted('mcp__brai__create_text_file') or catalog_permitted('terminal') or catalog_permitted('mcp__brai__brai_login'):
                raise RpcError(-32603, 'Worker role policy unavailable')
        if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
            from .native_policy import has_deferred_startup, prepared_principal
            if has_deferred_startup(runner) and self.policy_task is None:
                self.policy_ready.clear()
                self.policy_task = asyncio.create_task(self._activate_user_startup(
                    runner, self.adapter, prepared_principal()))
        self.tools_ready = True
        self.operational.set()

    async def _activate_user_startup(self, runner, adapter, expected):
        """Владеть ожиданием Auth и восстановлением; stop_runtime отменяет весь этап."""
        from .native_policy import principal, activate_deferred_startup
        def alive():
            if self.policy_stopping or self.runner is not runner or self.adapter is not adapter:
                raise asyncio.CancelledError()
        async def check():
            alive()
            current = await asyncio.to_thread(principal)
            alive()
            if current != expected:
                raise PermissionError('Runtime preparation changed')
        try:
            while True:
                alive()
                try:
                    current = await asyncio.to_thread(principal)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await asyncio.sleep(.5)
                    continue
                alive()
                if current != expected:
                    raise PermissionError('Runtime preparation changed')
                break
            if self.release.cold_start:
                if self.cold_recovery_task is not None:
                    raise RuntimeError('Previous cold recovery is still owned')
                if self.release.recovery_done.is_set():
                    if self.release.recovery_open.is_set():
                        raise RuntimeError('Previous cold recovery outcome is unresolved')
                    self.release.recovery_done.clear()
                self.cold_recovery_task = await activate_deferred_startup(
                    runner, adapter, check, release_open=self.release.recovery_open)
                def recovery_done(task):
                    try:
                        if task.cancelled():
                            if self.release.recovery_open.is_set():
                                self.policy_error = RuntimeError('Cold recovery cancelled')
                            return
                        error = task.exception()
                        if error is None:
                            try:
                                self.release.finish_cold_recovery()
                            except Exception as failure:
                                error = failure
                        if error is not None:
                            self.policy_error = self.lifecycle_error = error
                            self.exit_code = 1
                            runner._exit_code = 1
                            runner._request_clean_exit('role-activation-failed')
                    finally:
                        self.release.recovery_done.set()
                if self.cold_recovery_task is not None:
                    self.cold_recovery_task.add_done_callback(recovery_done)
            else:
                await activate_deferred_startup(runner, adapter, check)
            alive()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.policy_error = self.lifecycle_error = error
            self.exit_code = 1
            runner._exit_code = 1
            runner._request_clean_exit('role-activation-failed')
        finally:
            self.policy_ready.set()

    async def ensure_user_policy(self):
        """Не передавать первое событие одновременно с reload/restore пользователя."""
        await self.policy_ready.wait()
        if self.policy_stopping or self.policy_error is not None:
            raise RpcError(-32603, 'Worker startup unavailable')

    async def _run_lifecycle(self):
        """Выполнить native daemon lifecycle и сохранить service restart verdict."""
        # Bootstrap health EOF не завершает ещё не активированный native daemon.
        # Отмена до try оставляет listener для будущего постоянного ingress.
        await self.activation.wait()
        explicit_exit = False
        try:
            from gateway.run import start_gateway
            result = await start_gateway(
                runner_factory=lambda config: self.runner,
                startup_gate=self._startup_gate,
                operational_ready=self._operational_ready)
            self.exit_code = getattr(self.runner, 'exit_code', None)
            if self.exit_code is None:
                self.exit_code = 0 if result else 1
        except SystemExit as error:
            explicit_exit = True
            self.exit_code = error.code if type(error.code) is int else 1
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.lifecycle_error = error
            self.exit_code = 1
        finally:
            if self.policy_error is not None:
                self.exit_code = 1
            self.operational.clear()
            if explicit_exit or not self.peer_draining or self.exit_code not in (None, 0) or self.lifecycle_error is not None:
                self.exited.set()

    async def stop_runtime(self):
        """Дождаться native drain и внешней обвязки до освобождения peer."""
        async with self.runtime_stop_lock:
            if self.runtime_stopped:
                return
            await self._stop_runtime_once()
            self.runtime_stopped = True

    async def _stop_runtime_once(self):
        recovery = self.cold_recovery_task
        if recovery is not None and not recovery.done() and not self.release.recovery_open.is_set():
            # Nothing was admitted while the cold source remained held.
            recovery.cancel()
        if recovery is not None:
            await asyncio.gather(recovery, return_exceptions=True)
        if self.cold_recovery_task is recovery:
            self.cold_recovery_task = None
        self.policy_stopping = True
        policy = self.policy_task
        if policy is not None and not policy.done():
            policy.cancel()
        if policy is not None:
            await asyncio.gather(policy, return_exceptions=True)
        self.policy_task = None
        # Policy могла создать recovery пока ожидалось завершение предыдущей.
        recovery = self.cold_recovery_task
        if recovery is not None:
            if not recovery.done() and not self.release.recovery_open.is_set():
                recovery.cancel()
            await asyncio.gather(recovery, return_exceptions=True)
            self.cold_recovery_task = None
        self.policy_ready.set()
        task = self.lifecycle_task
        if task is not None and not self.activation.is_set() and not task.done():
            task.cancel()
        if self.runner is not None:
            await self.runner.stop()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def ensure_tools(self):
        """Однократно активировать полный startup и дождаться operational-ready."""
        async with self.tools_lock:
            if self.release.operation is not None and not self.release.cold_start and not self.activation.is_set():
                raise RpcError(-32603, 'Release holds native activation')
            if self.operational.is_set():
                return
            if self.lifecycle_task is None or self.lifecycle_task.done():
                raise RpcError(-32603, 'Worker startup unavailable')
            self.activation.set()
            ready = asyncio.create_task(self.operational.wait())
            try:
                await asyncio.wait((ready, self.lifecycle_task), return_when=asyncio.FIRST_COMPLETED)
                if not self.operational.is_set():
                    raise RpcError(-32603, 'Worker startup unavailable')
            finally:
                ready.cancel()
                await asyncio.gather(ready, return_exceptions=True)

    async def health(self, require_tools=False):
        """Различить доступный bootstrap и полный operational lifecycle."""
        if type(require_tools) is not bool:
            raise RpcError(-32602, 'Invalid health check')
        if self.runner is None or self.adapter is None or self.exited.is_set() or self.policy_stopping:
            raise RpcError(-32603, 'Worker not ready')
        if require_tools:
            await self.ensure_tools()
        from .native_policy import role_state
        return {'role': role_state(), 'rolePolicyVersion': 1, 'ready': True, 'operational': self.operational.is_set(),
                'policyReady': bool(self.operational.is_set() and self.policy_ready.is_set()
                                    and self.policy_error is None and not self.policy_stopping),
                'userId': self.user_id, 'telegramId': self.telegram_id}

    async def interactive(self, update, owner, scope_id, actor_telegram_id, chat_generation=None):
        """Передать проверенное интерактивное событие owner-bound адаптеру."""
        if self.release.operation is not None:
            raise RpcError(-32603, 'Release holds new dispatch')
        if (owner != self.user_id or not isinstance(update, dict)
                or not isinstance(scope_id, str) or not 1 <= len(scope_id) <= 128
                or not isinstance(actor_telegram_id, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', actor_telegram_id)):
            raise RpcError(-32602, 'Invalid interactive event')
        callback, inline = update.get('callback_query'), update.get('inline_query')
        if isinstance(callback, dict) and inline is None:
            message, actor = callback.get('message'), callback.get('from')
            chat = message.get('chat') if isinstance(message, dict) else None
            if (not isinstance(chat, dict) or chat.get('type') != 'private'
                    or str(chat.get('id')) != actor_telegram_id):
                raise RpcError(-32602, 'Invalid interactive route')
            # Private reply-UI anchor без is_topic_message не является native routing topic.
            thread = message.get('message_thread_id') if message.get('is_topic_message') is True else None
            source = SimpleNamespace(chat_id=str(chat['id']), thread_id=thread)
        elif isinstance(inline, dict) and callback is None:
            actor = inline.get('from')
            source = SimpleNamespace(chat_id=actor_telegram_id, thread_id=None)
        else:
            raise RpcError(-32602, 'Invalid interactive route')
        if (not isinstance(actor, dict) or str(actor.get('id')) != actor_telegram_id or actor.get('is_bot') is not False
                or chat_generation is not None and (type(chat_generation) is not int or chat_generation < 0)):
            raise RpcError(-32602, 'Invalid interactive actor or generation')
        route = self._chat_route(source)
        generation = 0 if chat_generation is None else chat_generation
        def allowed():
            return (self.route_allowed(source)
                    and generation == self.chat_states.get(route, {}).get('generation', 0))
        if not allowed():
            raise RpcError(-32602, 'Paused or stale interactive action')
        active = asyncio.current_task()
        self.chat_interactive.setdefault(route, set()).add(active)
        try:
            await self.ensure_tools()
            await self.ensure_user_policy()
            if not allowed():
                raise RpcError(-32602, 'Paused or stale interactive action')
            from .scope import delivery_scope
            token = delivery_scope.set(scope_id)
            try:
                await self.adapter.handle_interactive(update, telegram_id=actor_telegram_id)
                return {'accepted': True}
            finally:
                delivery_scope.reset(token)
        finally:
            self.chat_interactive[route].discard(active)
            self.browser_task_ended()

    async def dispatch_status(self, owner, delivery_id, input_digest):
        """Сверить прежний приём после разрыва RPC без повторного исполнения."""
        if owner != self.user_id:
            raise RpcError(-32602, 'Durable delivery unavailable')
        self._enable_delivery()
        async with self.delivery_lock:
            return self._delivery_status(delivery_id, input_digest)

    def _enable_delivery(self):
        """Доверенный ingress включает протокол без изменения прежних личных unit-файлов."""
        if self.delivery_journal is None:
            if (os.environ.get('BRAI_IDENTITY_MODE') != 'worker'
                    or os.environ.get('BRAI_IDENTITY_INSTANCE') not in (None, '', 'dev', 'release')):
                raise RpcError(-32602, 'Durable delivery unavailable')
            from .delivery_journal import DeliveryJournal
            self.delivery_journal = DeliveryJournal(Path(os.environ['HERMES_HOME']) / 'identity-delivery.sqlite3', self.user_id)
            if self.adapter is not None:
                self.adapter._brai_delivery_journal = self.delivery_journal

    def _delivery_status(self, ident, digest):
        """Не держать ingress навечно за ходом прежнего процесса; неизвестное действие не повторять."""
        status = self.delivery_journal.input_status(ident, digest)
        receipt = status.get('receipt') or {}
        if (status['state'] == 'accepted' and receipt.get('turn_id')
                and receipt['turn_id'] not in self.active and self.operational.is_set()
                and not any(not task.done() for task in getattr(self.adapter, '_session_tasks', {}).values())):
            return {**status, 'state': 'interrupted'}
        return status

    async def flush_outputs(self, owner):
        """Повторить только доставку готовых ответов; native задание не запускается."""
        if owner != self.user_id or self.peer is None:
            raise RpcError(-32602, 'Durable delivery unavailable')
        self._enable_delivery()
        sent = 0
        async with self.output_lock:
            for row in self.delivery_journal.pending_outputs():
                value = await self.peer.call('send', {'action': row['action'], **row['payload'], 'delivery_id': row['id']})
                if value.get('success') and value.get('message_id'):
                    self.delivery_journal.output_state(row['id'], 'sent', value)
                    sent += 1
                elif value.get('retryable') is False:
                    self.delivery_journal.output_state(row['id'], 'blocked', value)
                else:
                    break
        return {'sent': sent}

    async def dispatch(self, event, owner, delivery_id=None, input_digest=None):
        """Закрепить фактический native приём до RPC receipt; повтор ID возвращает его состояние."""
        if delivery_id is None and input_digest is None:
            return await self._dispatch_native(event, owner)
        if owner != self.user_id:
            raise RpcError(-32602, 'Durable delivery unavailable')
        self._enable_delivery()
        from .scope import input_delivery
        async with self.delivery_lock:
            previous = self._delivery_status(delivery_id, input_digest)
            if previous['state'] in ('accepted', 'completed', 'interrupted'):
                return {**previous['receipt'], 'delivery_state': previous['state']}
            if previous['state'] != 'not_received':
                raise RpcError(-32004, 'Input dispatch outcome requires reconciliation')
            self.delivery_journal.begin_input(delivery_id, input_digest)
            context = input_delivery.set(delivery_id)
            try:
                value = await self._dispatch_native(event, owner)
                if value.get('accepted') is False:
                    self.delivery_journal.decline_input(delivery_id, input_digest)
                    return {**value, 'delivery_state': 'not_received'}
                self.delivery_journal.accept_input(delivery_id, input_digest, value)
                if value.get('turn_id') and value['turn_id'] not in self.active:
                    self.delivery_journal.complete_turn(value['turn_id'])
                return {**value, 'delivery_state': 'accepted'}
            finally:
                input_delivery.reset(context)

    async def _dispatch_native(self, event, owner, *, _cancel_control=False):
        """Принять только событие привязанного владельца, не доверяя его metadata."""
        from gateway.platforms.event import MessageEvent, MessageType
        from gateway.session import SessionSource
        if self.release.operation is not None:
            raise RpcError(-32603, 'Release holds new dispatch')
        if owner != self.user_id or not isinstance(event, dict):
            raise RpcError(-32602, 'Invalid owner or event')
        from .native_policy import guest_mode
        if guest_mode() and str(event.get('text', '')).lstrip().startswith('/') and str(event.get('text', '')).split()[0].split('@')[0] not in ('/stop', '/cancel'):
            raise RpcError(-32603, 'Эта команда недоступна для гостя')
        source = SessionSource.from_dict(event['source'])
        actor = event['source'].get('brai_actor_id', str(source.user_id))
        if not isinstance(actor, str) or not actor.isascii() or not actor.isdecimal() or int(actor) <= 0:
            raise RpcError(-32602, 'Invalid Telegram actor')
        source._brai_actor_id = actor
        if self.operator_route == self._chat_route(source) and not _cancel_control:
            return {'accepted': False, 'turn_id': None}
        if source.platform.value != 'telegram' or str(source.user_id) != self.telegram_id or source.is_bot:
            raise RpcError(-32602, 'Invalid source')
        allowed = {'text', 'user_id', 'user_name', 'message_id', 'media_urls', 'media_types', 'media_text_inlined', 'reply_to_message_id', 'reply_to_text', 'timestamp', 'reply_expected'}
        if set(event) - allowed - {'source', 'message_type', 'identity_inputs', 'delivery_scope', 'chat_generation', 'voice_retry'}:
            raise RpcError(-32602, 'Unsupported event fields')
        fields = {key: event[key] for key in allowed if key in event}
        if 'timestamp' in fields:
            fields['timestamp'] = datetime.fromisoformat(fields['timestamp'])
        fields['user_id'] = self.telegram_id
        self.adapter.bind_source(source)
        message = MessageEvent(source=source, message_type=MessageType(event.get('message_type', 'text')), **fields)
        original = event['source'].get('brai_dialogues_original')
        if isinstance(original, str):
            message._brai_original_text = original
            if os.environ.get('BRAI_DIALOGUES_REQUIRED') == '1' and message.message_id is not None:
                origin = self.runner._steer_text_with_origin('Вход пользователя', message)
                try:
                    archive_id = json.loads(origin.split('\n', 2)[1])['message_id']
                except (IndexError, KeyError, TypeError, ValueError):
                    pass
                else:
                    source._brai_dialogues_input = (str(archive_id), original)
        from .scope import input_delivery
        message._brai_identity_input_id = input_delivery.get()
        message._brai_input_delivery_id = message._brai_identity_input_id
        from gateway.platforms import base as native_base
        coerce = getattr(native_base, 'coerce_plaintext_gateway_command', None)
        if callable(coerce):
            coerce(message)
        from .ordinary_admission import command_name
        command = getattr(message, 'get_command', None)
        if not _cancel_control and (command() if callable(command) else command_name(message.text)) is not None:
            # Вход потреблён политикой, без native задачи. Durable transport не
            # должен повторять отказ как временную занятость исполнителя.
            return {'accepted': True, 'turn_id': None}
        inputs = event.get('identity_inputs', [])
        if not isinstance(inputs, list) or len(inputs) > 10:
            raise RpcError(-32602, 'Invalid input files')
        home = os.environ.get('HERMES_HOME', '')
        for item in inputs:
            if (not isinstance(item, dict) or set(item) - {'path', 'itemId', 'caption', 'groupId'}
                    or not isinstance(item.get('path'), str) or not home.startswith('/')
                    or not os.path.isabs(item['path'])
                    or os.path.commonpath((os.path.abspath(item['path']), os.path.abspath(home))) != os.path.abspath(home)
                    or not isinstance(item.get('itemId'), str) or not item['itemId']
                    or any(key in item and item[key] is not None and not isinstance(item[key], str) for key in ('caption', 'groupId'))):
                raise RpcError(-32602, 'Invalid input file')
        message._brai_identity_inputs = inputs
        if 'voice_retry' in event:
            if event['voice_retry'] is not True or message.message_type != MessageType.VOICE or len(inputs) != 1:
                raise RpcError(-32602, 'Invalid voice retry')
            message._brai_voice_retry = True
        if not isinstance(message.message_id, str) or not message.message_id:
            raise RpcError(-32602, 'Message ID required')
        scope_id = event.get('delivery_scope')
        if (os.environ.get('BRAI_IDENTITY_MODE') == 'worker'
                and (not isinstance(scope_id, str) or not 1 <= len(scope_id) <= 128)):
            raise RpcError(-32602, 'Delivery scope required')
        from .scope import delivery_scope
        message._brai_delivery_scope = scope_id
        scope_token = delivery_scope.set(scope_id)
        typing = None
        route = self._chat_route(source)
        generation = event.get('chat_generation', 0)
        if type(generation) is not int or generation < 0:
            raise RpcError(-32602, 'Invalid chat generation')
        message._brai_chat_generation = generation
        self.chat_dispatches[route] = self.chat_dispatches.get(route, 0) + 1
        try:
            key = self.adapter._event_session_key(message)
            if not _cancel_control and await self._operator_turn_held(key):
                await self.runner.async_session_store.clear_resume_pending(key)
                self.delivery_journal.clear_operator_turn(key)
            before = self.adapter._session_tasks.get(key)
            if (self.delivery_journal is not None and not str(getattr(message, 'text', '')).lstrip().startswith('/')
                    and any(other != key and not task.done() for other, task in self.adapter._session_tasks.items())):
                return {'accepted': False, 'turn_id': None}
            typing = self.adapter.start_turn_typing(message)
            await self.ensure_tools()
            await self.ensure_user_policy()
            if generation > self.chat_states.get(route, {}).get('generation', 0):
                # AIDEV-NOTE: Trusted ingress посылает dispatch только после durable resume.
                # Новое поколение восстанавливает resume receipt, потерянный при разрыве IPC.
                self.chat_states[route] = {'chat': route[0], 'thread': route[1], 'paused': False,
                                          'generation': generation, 'recoveryBlocked': True}
            if (not self.route_allowed(source)
                    or generation != self.chat_states.get(route, {}).get('generation', 0)):
                return {'accepted': False, 'turn_id': None}
            async with self.chat_locks.setdefault(route, asyncio.Lock()):
                if (not self.route_allowed(source)
                        or generation != self.chat_states.get(route, {}).get('generation', 0)):
                    return {'accepted': False, 'turn_id': None}
                state = self.chat_states.get(route)
                if state is not None and state['recoveryBlocked']:
                    # AIDEV-NOTE: После restart native иначе добавляет к новому input
                    # resume-note старого задания. API снимает только маркер, сохраняя сессию.
                    clear = getattr(getattr(self.runner, 'async_session_store', None), 'clear_resume_pending', None)
                    if not callable(clear):
                        raise RpcError(-32603, 'Native recovery control unavailable')
                    await clear(key)
                    if (not self.route_allowed(source)
                            or generation != self.chat_states.get(route, {}).get('generation', 0)):
                        return {'accepted': False, 'turn_id': None}
                from tools.approval_conversation import gateway_input_prepared
                reply = await gateway_input_prepared(self.runner, message, message)
                if (not self.route_allowed(source)
                        or generation != self.chat_states.get(route, {}).get('generation', 0)):
                    return {'accepted': False, 'turn_id': None}
                if reply is None:
                    await self.adapter.handle_message(message)
                else:
                    if reply:
                        await self.runner._send_busy_reply(message, self.adapter, reply)
                    message._gateway_accepted = True
            task = self.adapter._session_tasks.get(key)
            state = self.chat_states.get(route)
            if message._gateway_accepted and state is not None and not state['paused'] and state['generation'] == generation:
                # AIDEV-NOTE: Только принятый новый input снимает recovery fence.
                # Resume не исполняет старые resume_pending или native queue.
                state['recoveryBlocked'] = False
            token = None
            if self.delivery_journal is not None and message._gateway_accepted and task is not None and task is before:
                token = next((value for value, record in self.active.items() if record[0] == key), None)
            if message._gateway_accepted and task is not None and task is not before:
                # Native переносит pending follow-up в новую drain task того же session key.
                # Один живой допуск ingress покрывает всю цепочку до освобождения сессии.
                token = next((value for value, record in self.active.items() if record[0] == key), None)
                previous = self.active.get(token)
                token = token or uuid.uuid4().hex
                self.active[token] = (key, task, source.to_dict())
                self.turn_scopes[token] = scope_id
                if typing is not None and token not in self.typing:
                    self.typing[token] = typing
                    typing = None
                if previous is None or previous[1] is not task:
                    task.add_done_callback(lambda done: self._turn_finished(token, done))
            return {'accepted': bool(message._gateway_accepted), 'turn_id': token}
        finally:
            self.chat_dispatches[route] -= 1
            self.browser_task_ended()
            delivery_scope.reset(scope_token)
            if typing is not None:
                typing.cancel()
                await asyncio.gather(typing, return_exceptions=True)

    def _turn_finished(self, token, done):
        """Сообщить ingress точный завершённый ход без повторной доставки."""
        if self.active.get(token, (None, None))[1] is not done:
            return
        key, _, source = self.active[token]
        replacement = self.adapter._session_tasks.get(key) if self.adapter is not None else None
        if replacement is not None and replacement is not done and not replacement.done():
            self.active[token] = (key, replacement, source)
            replacement.add_done_callback(lambda next_done: self._turn_finished(token, next_done))
            return
        self.active.pop(token, None)
        self.browser_task_ended()
        if self.delivery_journal is not None and not done.cancelled() and done.exception() is None:
            self.delivery_journal.complete_turn(token)
        self.turn_scopes.pop(token, None)
        typing = self.typing.pop(token, None)
        if typing is not None:
            typing.cancel()
        peer = self.peer
        if peer is not None and not peer.closed:
            async def notify():
                try:
                    await peer.call('turn_ended', {'owner': self.user_id, 'turn_id': token}, timeout=5)
                except (ConnectionError, TimeoutError, RpcError):
                    pass  # Разрыв не доказывает, доставлено ли уведомление.
            asyncio.create_task(notify())

    @staticmethod
    def _chat_route(source):
        thread = str(getattr(source, 'thread_id', None) or '')
        return (str(source.chat_id), '' if thread == '1' else thread)

    @staticmethod
    def _validate_chat_state(state):
        if (not isinstance(state, dict) or not isinstance(state.get('chat'), str)
                or re.fullmatch(r'[1-9][0-9]{0,19}', state['chat']) is None
                or not isinstance(state.get('thread'), str)
                or state['thread'] and re.fullmatch(r'[1-9][0-9]{0,15}', state['thread']) is None
                or type(state.get('paused')) is not bool
                or type(state.get('generation')) is not int or state['generation'] < 0
                or type(state.get('recoveryBlocked')) is not bool):
            raise RpcError(-32602, 'Invalid chat state')

    @contextmanager
    def shutdown_notice_scope(self, session_key):
        """Выбрать действующий ingress scope этого хода без фонового маршрута."""
        from .scope import delivery_scope, ephemeral_input
        matches = [(token, task) for token, (key, task, _) in self.active.items()
                   if key == session_key and task is not None and not task.done()
                   and self.turn_scopes.get(token)]
        if len(matches) != 1:
            recovery = self.recovery_scopes.get(session_key)
            if (matches or recovery is None or recovery[0].done()
                    or not self.route_allowed(recovery[2], recovery=True)):
                yield False
                return
            token = ephemeral_input.set(recovery[1])
            scope_token = delivery_scope.set(None)
            try:
                yield self.recovery_scopes.get(session_key) is recovery and not recovery[0].done()
            finally:
                delivery_scope.reset(scope_token)
                ephemeral_input.reset(token)
            return
        turn, task = matches[0]
        scope = self.turn_scopes[turn]
        token = delivery_scope.set(scope)
        try:
            yield (self.active.get(turn, (None, None))[1] is task
                   and not task.done() and self.turn_scopes.get(turn) == scope)
        finally:
            delivery_scope.reset(token)

    def return_notice_state(self, chat, thread):
        """Вернуть известное поколение маршрута без создания нового состояния."""
        if not self.chat_snapshot_ready:
            return None
        route = self._chat_route(SimpleNamespace(chat_id=chat,thread_id=thread))
        state = self.chat_states.get(route,{})
        return {'generation': state.get('generation',0), 'paused': bool(state.get('paused'))}

    def route_allowed(self, source, *, recovery=False):
        """Закрыть dispatch/recovery при неизвестном snapshot, паузе или незавершённой отмене."""
        if not self.chat_snapshot_ready and (recovery or os.environ.get('BRAI_IDENTITY_MODE') == 'worker'):
            return False
        route = self._chat_route(source)
        state = self.chat_states.get(route, {})
        if state.get('paused') or recovery and state.get('recoveryBlocked'):
            return False
        return not any(not task.done() for task in self.chat_stopping.get(route, ()))

    async def chat_pause(self, owner, chat, thread, paused, generation):
        """Применить trusted route fence и отменить native ход без смены session/history."""
        if owner != self.user_id:
            raise RpcError(-32602, 'Invalid owner')
        state = dict(chat=chat, thread=thread, paused=paused, generation=generation, recoveryBlocked=True)
        self._validate_chat_state(state)
        route = (chat, thread)
        old = self.chat_states.get(route)
        if old is not None and old['generation'] > generation:
            return {'state': 'stopping' if old['paused'] else 'resumed'}
        if old is not None and old['generation'] == generation and not old['paused'] and not paused:
            return {'state': 'resumed'}
        self.chat_states[route] = state
        if paused:
            callbacks = set(self.chat_interactive.get(route, ()))
            self.chat_stopping.setdefault(route, set()).update(callbacks)
            for callback in callbacks:
                callback.cancel()
        async with self.chat_locks.setdefault(route, asyncio.Lock()):
            if not paused:
                return {'state': 'resumed'}
            if self.runner is None or self.adapter is None:
                return {'state': 'stopping' if any(not task.done() for task in self.chat_stopping.get(route, ())) else 'stopped'}
            from gateway.session import SessionSource
            source = SessionSource.from_dict({'platform': 'telegram', 'chat_id': chat,
                'chat_type': 'dm', 'thread_id': thread or None, 'user_id': self.telegram_id})
            key = self.adapter._event_session_key(SimpleNamespace(source=source))
            cancel_consent = getattr(self.runner, '_brai_cancel_consent_for_source', None)
            if callable(cancel_consent):
                cancel_consent(source)
            task = self.adapter._session_tasks.get(key)
            tasks = set(self.chat_stopping.get(route, ()))
            if task is not None and not task.done():
                tasks.add(task)
            self.chat_stopping[route] = tasks
            # AIDEV-NOTE: /stop сохраняет internal wake; admin pause удаляет всю очередь.
            # Native suspended=True запрещён: следующий input создал бы новую сессию.
            def discard():
                getattr(self.adapter, '_pending_messages', {}).pop(key, None)
                getattr(self.runner, '_pending_messages', {}).pop(key, None)
                overflow = getattr(self.runner, '_overflow_queue', lambda _: None)(key)
                if overflow is not None:
                    overflow.clear()
                drop = getattr(self.adapter, '_discard_text_debounce', None)
                if callable(drop):
                    drop(key)
            discard()
            if tasks:
                from gateway.run import _INTERRUPT_REASON_STOP
                await self.runner._interrupt_and_clear_session(key, source,
                    interrupt_reason=_INTERRUPT_REASON_STOP, invalidation_reason='admin_chat_pause')
                discard()
                for active in tasks:
                    if not active.done():
                        active.cancel()
                done, pending = await asyncio.wait(tasks, timeout=5)
                return {'state': 'stopping' if pending or self.chat_dispatches.get(route, 0) else 'stopped'}
            return {'state': 'stopping' if self.chat_dispatches.get(route, 0) else 'stopped'}

    async def cancel(self, turn_id, owner):
        """Остановить только проверенный живой ход; таймаут не подтверждает остановку."""
        if owner != self.user_id or not isinstance(turn_id, str):
            raise RpcError(-32602, 'Invalid owner or turn')
        record = self.active.get(turn_id)
        if record is None:
            return {'state': 'not_running'}
        key, task, source = record
        replacement = self.adapter._session_tasks.get(key)
        if replacement is not None and replacement is not task and not replacement.done():
            task = replacement
            self.active[turn_id] = (key, task, source)
            task.add_done_callback(lambda done: self._turn_finished(turn_id, done))
        if task.done() or self.adapter._session_tasks.get(key) is not task:
            return {'state': 'not_running'}
        await self._dispatch_native({'text': '/stop', 'source': source, 'message_type': 'command',
                             'message_id': 'cancel:' + turn_id,
                             'delivery_scope': self.turn_scopes.get(turn_id)}, owner, _cancel_control=True)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5)
        except asyncio.TimeoutError:
            return {'state': 'stopping'}
        except asyncio.CancelledError:
            if not task.cancelled():
                raise
        return {'state': 'stopped'}



def _prepare_socket(path):
    """Удалить только собственный неработающий сокет после аварийного завершения."""
    try:
        old = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.getuid():
        raise PermissionError('Existing socket is not owned by worker')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        result = probe.connect_ex(path)
    if result != errno.ECONNREFUSED:
        raise FileExistsError('Worker socket is active or inaccessible')
    current = os.lstat(path)
    if (current.st_dev, current.st_ino) != (old.st_dev, old.st_ino):
        raise RuntimeError('Worker socket changed')
    os.unlink(path)


async def serve(path, worker, stop=None):
    """Слушать в собственном каталоге; UID вызывающего проверяется ядром."""
    _prepare_socket(path)
    server = await asyncio.start_unix_server(worker.serve_connection, path=path, limit=MAX_FRAME + 1)
    item = os.lstat(path)
    os.chmod(path, 0o666)
    try:
        async with server:
            if stop is None:
                await server.serve_forever()
            else:
                await stop.wait()
    finally:
        try:
            current = os.lstat(path)
            if (current.st_dev, current.st_ino) == (item.st_dev, item.st_ino):
                os.unlink(path)
        except FileNotFoundError:
            pass


def load_config(path, environ):
    """Проверить локальный worker.json и зафиксировать сокет внутри HERMES_HOME."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
                or info.st_mode & 0o022 or info.st_size > 4096):
            raise PermissionError('Invalid worker config')
        with os.fdopen(fd, 'rb', closefd=False) as data:
            config = json.load(data)
    finally:
        os.close(fd)
    if not isinstance(config, dict) or set(config) != {'socketPath'}:
        raise ValueError('Invalid worker config shape')
    home = environ.get('HERMES_HOME', '')
    expected = Path(home) / 'control' / 'worker.sock'
    if not home.startswith('/') or config['socketPath'] != str(expected):
        raise ValueError('Worker socket outside profile')
    ingress = environ.get('BRAI_IDENTITY_INGRESS_UID', '')
    owner = environ.get('BRAI_IDENTITY_USER_ID', '')
    telegram = environ.get('BRAI_IDENTITY_TELEGRAM_ID', '')
    egress = environ.get('BRAI_IDENTITY_EGRESS', '')
    if not ingress.isascii() or not ingress.isdecimal() or not owner or not telegram or not egress.startswith('/'):
        raise ValueError('Incomplete worker environment')
    return config['socketPath'], int(ingress), owner, telegram, egress


async def publish_delivery_file(file_path, *, broker=None):
    """Доставить уже принадлежащий артефакт по ID; guest публикует только admitted input."""
    if broker is None:
        from .tool_client import broker_call
        broker = broker_call
    import brai_files
    reference = brai_files.reference_metadata(file_path)
    if reference is not None:
        descriptor = await asyncio.to_thread(broker, 'artifacts.fetch', {'artifactId': reference['artifactId']})
        if descriptor.get('artifactId') != reference['artifactId']:
            raise PermissionError('Artifact mismatch')
    else:
        permissions = await asyncio.to_thread(broker, 'permissions.get', {})
        if permissions.get('role') not in ('creator', 'admin', 'user', 'guest'):
            raise PermissionError('Access unavailable')
        method = 'files.publish' if permissions['role'] == 'guest' else 'artifacts.publish'
        descriptor = await asyncio.to_thread(broker, method, {'path': file_path, 'requestId': str(uuid.uuid4())})
    if not isinstance(descriptor, dict) or not isinstance(descriptor.get('artifactId'), str) or not descriptor['artifactId']:
        raise RuntimeError('Broker returned no artifact')
    return {'artifact_id': descriptor['artifactId']}


async def run(config_path):
    """Запустить relay и worker; остановить оба при штатном SIGTERM."""
    from .network import start_relay, close_relay
    from .tool_client import broker_call
    # У файлового bootstrap только привязанный по UID broker; старый fixed-owner порт запрещён.
    os.environ['BRAI_IDENTITY_MODE'] = 'worker'
    sys.modules['_brai_identity_worker'] = SimpleNamespace(
        call=lambda method, params, timeout: broker_call(method, params, timeout=timeout))
    path, ingress, owner, telegram, egress = load_config(config_path, os.environ)
    worker = Worker(ingress, owner, telegram, publish_delivery_file)
    worker.release.bootstrap(Path(__file__))
    from .skills import install_policy
    install_policy()
    relay = await start_relay(egress, port=18080)
    browser_relay = None
    try:
        browser_egress = os.environ.get('BRAI_IDENTITY_BROWSER_EGRESS')
        if browser_egress:
            if browser_egress != '/run/brai-profile/browser-egress.sock':
                raise ValueError('Invalid browser egress socket')
            browser_relay = await start_relay(browser_egress, port=18081)
        if os.environ.get('BRAI_IDENTITY_BROWSER_ON_DEMAND') == '1':
            from .browser_demand import BrowserDemand
            worker.browser = BrowserDemand(worker.browser_working)
            await worker.browser.open()
    except BaseException:
        if browser_relay is not None:
            await close_relay(browser_relay)
        await close_relay(relay)
        raise
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)
    serving = asyncio.create_task(serve(path, worker, stop))
    exited = asyncio.create_task(worker.exited.wait())
    try:
        await asyncio.wait((serving, exited), return_when=asyncio.FIRST_COMPLETED)
        stop.set()
        await worker.stop_runtime()
        await serving
    finally:
        exited.cancel()
        await asyncio.gather(exited, return_exceptions=True)
        if worker.browser is not None:
            await worker.browser.close()
        if browser_relay is not None:
            await close_relay(browser_relay)
        await close_relay(relay)
    if worker.exit_code:
        raise SystemExit(worker.exit_code)


def main():
    """Запустить worker из подготовленного systemd профиля."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(args.config))
    except SystemExit as error:
        exit_code = 0 if error.code is None else error.code if type(error.code) is int else 1
    else:
        exit_code = 0
    if 'gateway.run' in sys.modules:
        sys.modules['gateway.run']._exit_after_graceful_shutdown(exit_code)
    raise SystemExit(exit_code)


if __name__ == '__main__':
    main()
