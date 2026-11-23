# ABOUTME: Проверяет предупреждения активных чатов и удаление старых уведомлений о возврате.
# ABOUTME: Исполняет точный модуль overlay с тестовым транспортом и временными файлами.
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[4]
PATCH = ROOT / 'services/hermes/extensions/patches/hermes-core.patch'


def module_source():
    """Извлечь полный создаваемый модуль из патча."""
    raw = PATCH.read_text()
    header = 'diff --git a/gateway/return_notices.py b/gateway/return_notices.py\n'
    section = raw[raw.index(header) + len(header):].split('diff --git ', 1)[0]
    return '\n'.join(line[1:] for line in section.splitlines()
                     if line.startswith('+') and not line.startswith('+++')) + '\n'


class ReturnNoticeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'tmp')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'pending.json'
        self.module = ModuleType('candidate_return_notices')
        utils = NS(atomic_json_write=lambda path, data, **_: path.write_text(json.dumps(data)))
        with patch.dict(sys.modules, {'utils': utils}):
            exec(compile(module_source(), str(PATCH), 'exec'), self.module.__dict__)
        self.runner = self.module.GatewayReturnNoticesMixin()
        self.runner._send_notice_logged = AsyncMock(return_value=True)
        self.runner._brai_return_notice_state = lambda chat, thread: {'generation': 1, 'paused': False}
        self.ports = patch.dict(sys.modules, {
            'gateway.run': NS(_planned_restart_notification_path=lambda: self.path),
        })
        self.ports.start()
        self.addCleanup(self.ports.stop)

    async def test_active_warning_does_not_create_return_receipt(self):
        sent = await self.runner._send_shutdown_notice(object(), '42', 'warning', 'active chat',
                                                       'telegram', return_thread_id='7')
        self.assertTrue(sent)
        self.runner._send_notice_logged.assert_awaited_once()
        self.assertFalse(self.path.exists())

    async def test_paused_or_unknown_chat_does_not_receive_warning(self):
        for state in (None, {'generation': 1, 'paused': True}):
            self.runner._brai_return_notice_state = lambda chat, thread: state
            self.assertFalse(await self.runner._send_shutdown_notice(
                object(), '42', 'warning', 'active chat', 'telegram', return_thread_id='7'))
        self.runner._send_notice_logged.assert_not_awaited()

    async def test_old_recipient_and_legacy_markers_are_removed_without_send(self):
        for value in ('{"recipients":[{"chat_id":"42"}]}', '{}', 'corrupt'):
            self.path.write_text(value)
            await self.runner._replay_pending_planned_restart_notification()
            self.assertFalse(self.path.exists())
        self.runner._send_notice_logged.assert_not_awaited()

    async def test_failed_marker_removal_is_nonfatal(self):
        with patch.object(Path, 'unlink', side_effect=OSError('read-only')):
            await self.runner._replay_pending_planned_restart_notification()


if __name__ == '__main__':
    unittest.main()
