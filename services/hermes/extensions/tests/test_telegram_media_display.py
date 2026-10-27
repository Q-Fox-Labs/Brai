# ABOUTME: Проверяет отображение и отправку медиа Telegram без сети.
# ABOUTME: Конструктор адаптера изолирован от bootstrap внешнего файлового модуля.
"""Offline contracts: control data never becomes chat text; attachments keep their bytes."""
import asyncio
import importlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

# Load reviewed source candidates before constructing adapters/consumers.
if os.environ.get('MEDIA_DISPLAY_CANDIDATE'):
    for name, relative in [('gateway.platforms.base', 'gateway/platforms/base.py'),
                           ('plugins.platforms.telegram.adapter', 'plugins/platforms/telegram/adapter.py'),
                           ('gateway.stream_consumer', 'gateway/stream_consumer.py')]:
        path = Path(os.environ['MEDIA_DISPLAY_CANDIDATE']) / relative
        if not path.exists():
            continue
        importlib.import_module(name)
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        parent, attr = name.rsplit('.', 1)
        setattr(importlib.import_module(parent), attr, module)
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.stream_consumer import GatewayStreamConsumer
from gateway.run_turn import GatewayTurnMixin
from gateway.run_notifications import GatewayNotificationsMixin
from plugins.platforms.telegram import adapter as telegram

clean = BasePlatformAdapter.strip_media_directives_for_display
VOICE = '[[audio_as_voice]]\n\n[[audio_as_voice]]\nMEDIA:"/tmp/speech.ogg"'

class DisplayTests(unittest.TestCase):
    def test_local_delivery_forms_and_types_are_hidden(self):
        # Known/unknown/missing files; no filesystem existence required for display.
        for ext in ['ogg', 'opus', 'mp3', 'wav', 'm4a', 'png', 'jpg', 'mp4', 'pdf', 'md', 'zip', 'log', 'unknown']:
            for path in [f'/tmp/file.{ext}', f'~/exports/file.{ext}', f'C:\\exports\\file.{ext}']:
                for tag in [f'MEDIA:{path}', f'MEDIA:"{path}"', f"MEDIA:'{path}'", f'MEDIA:`{path}`', f'**MEDIA:{path}**']:
                    with self.subTest(tag=tag):
                        self.assertEqual(clean('Готово\n'+tag).strip(), 'Готово')
        self.assertEqual(clean('MEDIA:"/tmp/Отчёт за год.pdf"'), '')
        self.assertEqual(clean('MEDIA:/tmp/a.pngMEDIA:/tmp/b.pdf'), '')
        self.assertEqual(clean('[[as_document]]\n'+VOICE), '')

    def test_every_stream_prefix_hides_a_path_before_its_extension_or_quote(self):
        for value in [VOICE, 'MEDIA:"/tmp/Отчёт за год.pdf"', 'MEDIA:/tmp/unfamiliar.type']:
            for end in range(1, len(value)+1):
                visible = GatewayStreamConsumer._clean_for_display(value[:end])
                with self.subTest(end=end, value=value):
                    self.assertNotIn('/tmp', visible)
                    self.assertNotIn('MEDIA:', visible)
                    self.assertNotIn('[[audio', visible)

    def test_normal_prose_urls_and_documentation_remain(self):
        for text in ['**Готово**\nОткрой https://example.org/report.pdf',
                     'Настройка /etc/example.conf нужна для запуска.',
                     '```text\nMEDIA:/example/nonexistent.pdf\n[[audio_as_voice]]\n```',
                     '`MEDIA:/example/nonexistent.pdf`',
                     '> MEDIA:/example/nonexistent.pdf',
                     '{"result": "MEDIA:/example/nonexistent.pdf"}']:
            with self.subTest(text=text):
                self.assertEqual(clean(text), text)

    def test_local_links_keep_labels_without_internal_destinations(self):
        for destination in ['/tmp/result.pdf','</tmp/Отчёт (2).pdf>','file:///tmp/result.pdf']:
            text='Готово: [Отчёт]('+destination+')'
            with self.subTest(text=text):
                self.assertEqual(clean(text),'Готово: Отчёт')
                # A streaming destination must never reveal even the first directory.
                for end in range(text.index('](')+3,len(text)+1):
                    self.assertNotIn('/tmp',clean(text[:end]))
        self.assertEqual(clean('[Сайт](https://example.org/report.pdf)'), '[Сайт](https://example.org/report.pdf)')
        example='```text\n[Файл](</tmp/report.pdf>)\n```'
        self.assertEqual(clean(example),example)

    def test_extraction_keeps_voice_flags_dedup_and_original_bytes(self):
        media, text = BasePlatformAdapter.extract_media('Ответ\n'+VOICE+'\nMEDIA:"/tmp/speech.ogg"')
        self.assertEqual(media, [('/tmp/speech.ogg', True)])
        self.assertEqual(text, 'Ответ')

class EgressTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.guards=[]
        self.patch(telegram, 'ParseMode', NS(MARKDOWN_V2='MarkdownV2'))
        with patch.dict(sys.modules, {'brai_files': NS(install_adapter=lambda _: None)}):
            self.adapter=telegram.TelegramAdapter(PlatformConfig(enabled=True))
        self.adapter._bot=NS(edit_message_text=AsyncMock(), delete_message=AsyncMock(),
                             send_message_draft=AsyncMock(return_value=True), send_voice=AsyncMock())
        self.patch(self.adapter, '_rich_eligible', lambda _: False)
        self.patch(self.adapter, '_should_attempt_rich_draft', lambda _: False)
        self.patch(self.adapter, '_chat_outbound_slot_remaining', lambda _: 0)

    def patch(self, target, name, value):
        guard=patch.object(target,name,value);guard.start();self.addCleanup(guard.stop)

    async def test_regular_and_interim_send_are_clean_before_either_renderer(self):
        sender=AsyncMock(return_value=SendResult(success=True,message_id='101'))
        self.patch(self.adapter,'_send_text_locked',sender)
        for metadata in [None, {'_interim_send': True}]:
            await self.adapter.send('-100001','Ответ\n'+VOICE,metadata=metadata)
            self.assertEqual(sender.call_args.args[1], 'Ответ')
        sender.reset_mock()
        result=await self.adapter.send('-100001',VOICE)
        self.assertTrue(result.success)
        self.assertEqual(sender.call_args.args[1], 'Вложение не отправлено: файл недоступен.')
        sender.reset_mock()
        await self.adapter.send('-100001', VOICE, metadata={'_interim_send': True})
        sender.assert_not_awaited()

    async def test_both_preview_and_final_edits_hide_directives(self):
        for finalize in [False,True]:
            result=await self.adapter.edit_message('-100001','101','Ответ\n'+VOICE,finalize=finalize)
            self.assertTrue(result.success)
            self.assertEqual(self.adapter._bot.edit_message_text.call_args.kwargs['text'],'Ответ')

    async def test_media_only_final_removes_preview_without_empty_text_send(self):
        result=await self.adapter.edit_message('-100001','101',VOICE,finalize=True)
        self.assertTrue(result.success)
        self.adapter._bot.edit_message_text.assert_not_awaited()
        self.adapter._bot.delete_message.assert_awaited_once_with(chat_id=-100001,message_id=101)

    async def test_preview_delete_failure_is_not_reported_as_delivered(self):
        self.adapter._bot.delete_message.side_effect=RuntimeError('offline')
        result=await self.adapter.edit_message('-100001','101',VOICE,finalize=True)
        self.assertFalse(result.success)
        self.adapter._bot.edit_message_text.assert_not_awaited()

    async def test_draft_hides_directives_and_never_submits_empty_payload(self):
        result=await self.adapter.send_draft('100001',1,'Ответ\n'+VOICE)
        self.assertTrue(result.success)
        self.assertEqual(self.adapter._bot.send_message_draft.call_args.kwargs['text'],'Ответ')
        self.adapter._bot.send_message_draft.reset_mock()
        await self.adapter.send_draft('100001',1,VOICE)
        self.adapter._bot.send_message_draft.assert_not_awaited()

    async def test_plain_parse_fallback_is_also_clean(self):
        self.adapter._bot.edit_message_text.side_effect=[ValueError("Can't parse entities"),None]
        result=await self.adapter.edit_message('-100001','101','Ответ\n'+VOICE,finalize=True)
        self.assertTrue(result.success)
        self.assertEqual(self.adapter._bot.edit_message_text.call_args.kwargs['text'],'Ответ')

    async def test_control_buttons_and_callback_plain_fallback_keep_only_text(self):
        sender=AsyncMock(return_value=NS(message_id=101))
        self.patch(self.adapter,'_send_message_with_thread_fallback',sender)
        await self.adapter._send_control_message('100001','План\n'+VOICE,parse_mode=None,
                                                 thread_id=None,metadata=None,reply_markup='keyboard')
        self.assertEqual(sender.call_args.kwargs['text'],'План')
        self.assertEqual(sender.call_args.kwargs['reply_markup'],'keyboard')
        query=NS(edit_message_text=AsyncMock(side_effect=[ValueError('parse'),None]))
        await self.adapter._edit_result_text(query,'Ответ\n'+VOICE)
        for call in query.edit_message_text.await_args_list:
            self.assertEqual(call.kwargs['text'],'Ответ')

    async def test_media_and_voice_captions_keep_text_on_both_formatting_attempts(self):
        self.assertEqual(self.adapter._caption_1024('Подпись\n'+VOICE),'Подпись')
        send=AsyncMock(side_effect=[ValueError('parse entities'),NS(message_id=101)])
        self.patch(self.adapter,'_send_media',send)
        await self.adapter._send_voice_bubble(io.BytesIO(b'OggS synthetic'),'-100001',None,None,'Ответ\n'+VOICE,1)
        self.assertEqual(len(send.await_args_list),2)
        for call in send.await_args_list:
            self.assertEqual(call.kwargs['caption'],'Ответ')

    async def test_transformed_voice_final_still_reaches_attachment_dispatch_once(self):
        runner=GatewayTurnMixin()
        source=NS(chat_id='-100001',platform=Platform.TELEGRAM)
        consumer=NS(adapter=self.adapter,message_id='101',final_content_delivered=False,final_response_sent=False)
        context=NS(stream_consumer_holder=[consumer],source=source,session_key='synthetic')
        # Разрешаем только временные файлы этого теста в медиа-политике.
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            os.environ['HERMES_MEDIA_ALLOW_DIRS'] = directory
            path=Path(directory)/'speech.ogg';data=b'OggS synthetic attachment';path.write_bytes(data)
            original='Ответ\n[[audio_as_voice]]\n[[audio_as_voice]]\nMEDIA:"'+str(path)+'"'
            response={'final_response':original,'response_transformed':True}
            await runner._run_agent_mark_streamed_delivery(response,context)
            self.assertTrue(response['already_sent'])
            self.assertEqual(response['final_response'],original)
            self.assertEqual(self.adapter._bot.edit_message_text.call_args.kwargs['text'],'Ответ')
            self.patch(self.adapter,'send_voice',AsyncMock(return_value=SendResult(success=True,message_id='102')))
            await GatewayNotificationsMixin()._deliver_media_from_response(original,NS(source=source),self.adapter,thread_metadata={})
            self.adapter.send_voice.assert_awaited_once()
            self.assertEqual(self.adapter.send_voice.call_args.kwargs['audio_path'],str(path))
            self.assertTrue(self.adapter.send_voice.call_args.kwargs['is_voice'])
            self.assertEqual(path.read_bytes(),data)

    async def test_image_document_video_and_regular_audio_still_dispatch(self):
        for name in ['send_multiple_images','send_document','send_video','send_voice']:
            self.patch(self.adapter,name,AsyncMock(return_value=SendResult(success=True,message_id='102')))
        # Разрешаем только временные файлы этого теста в медиа-политике.
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            os.environ['HERMES_MEDIA_ALLOW_DIRS'] = directory
            paths=[]
            for ext in ['png','pdf','mp4','mp3']:
                path=Path(directory)/('output.'+ext);path.write_bytes(b'synthetic '+ext.encode());paths.append(path)
            original='Готово\n'+'\n'.join(f'MEDIA:"{path}"' for path in paths)
            self.assertEqual(clean(original),'Готово')
            source=NS(chat_id='-100001',platform=Platform.TELEGRAM)
            await GatewayNotificationsMixin()._deliver_media_from_response(original,NS(source=source),self.adapter,thread_metadata={})
            for name in ['send_multiple_images','send_document','send_video','send_voice']:
                getattr(self.adapter,name).assert_awaited_once()
            self.assertFalse(self.adapter.send_voice.call_args.kwargs['is_voice'])
            for path in paths:
                self.assertEqual(path.read_bytes(),b'synthetic '+path.suffix[1:].encode())

if __name__=='__main__':
    unittest.main()
