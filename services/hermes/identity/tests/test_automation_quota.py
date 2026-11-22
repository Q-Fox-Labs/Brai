# ABOUTME: Проверяет суточный лимит на собранном Hermes с настоящим SQLite.
# ABOUTME: Подменяет Auth, модель и внешнюю доставку, не привлекая живые аккаунты.
import importlib
import json
import multiprocessing as mp
import os
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def reserve_in_child(job_id, channel):
    """Отдельный процесс использует те же тестовые настройки домашнего профиля."""
    quota = importlib.import_module("identity.automation_quota")
    value = quota.reserve({"id": job_id}, job_id)
    channel.send((value.number, value.explain))
    channel.close()


@unittest.skipUnless(os.environ.get("BRAI_QUOTA_NATIVE_ENGINE"), "Нужен собранный кандидат Hermes")
class AutomationQuotaTests(unittest.TestCase):
    def setUp(self):
        self.quota = importlib.import_module("identity.automation_quota")
        from cron import executions, jobs, scheduler
        from agent import i18n

        expected = Path(os.environ["BRAI_QUOTA_NATIVE_ENGINE"]).resolve()
        self.assertEqual(Path(scheduler.__file__).resolve().parents[1], expected)
        self.executions, self.jobs, self.scheduler = executions, jobs, scheduler
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.dict(os.environ, {
            "HERMES_HOME": str(self.home), "HERMES_LANGUAGE": "ru",
        }))
        self.enterContext(jobs.use_cron_store(self.home))
        self.enterContext(patch.object(executions, "EXECUTIONS_FILE", None))
        self.role = self.enterContext(patch.object(self.quota, "principal", return_value={"role": "user"}))
        self.day = datetime(2026, 11, 22, 12, tzinfo=timezone(timedelta(hours=3)))
        self.clock = self.enterContext(patch("hermes_time.now", return_value=self.day))
        self.policy = self.home / "policy.json"
        self.set_limit(24)
        self.enterContext(patch.object(self.quota, "POLICY_PATH", self.policy))
        i18n.reset_language_cache()

    def set_limit(self, limit):
        self.policy.write_text(json.dumps({"userDailyAutomationLimit": limit}))

    @property
    def db(self):
        return self.home / "cron/executions.db"

    def reserve(self, job_id, *, execution_id=None, scheduled=None):
        job = {"id": job_id, "_scheduled_instant": scheduled}
        return self.quota.reserve(job, execution_id or job_id)

    def test_roles_are_checked_before_configuration_or_storage(self):
        self.policy.unlink()
        for role in ("creator", "admin"):
            self.role.return_value = {"role": role}
            self.assertIsNone(self.reserve("privileged"))
        self.role.return_value = {"role": "guest"}
        with self.assertRaises(PermissionError):
            self.reserve("guest")
        self.role.side_effect = PermissionError("Auth unavailable")
        with self.assertRaises(PermissionError):
            self.reserve("unknown")
        self.assertFalse(self.db.exists())

    def test_boundary_is_shared_across_jobs_and_explanation_is_reserved_once(self):
        with ThreadPoolExecutor(max_workers=8) as threads:
            rows = list(threads.map(self.reserve, (f"job-{i}" for i in range(28))))
        self.assertEqual(sorted(row.number for row in rows), list(range(1, 29)))
        self.assertEqual(sum(not row.exceeded for row in rows), 24)
        self.assertEqual([row.number for row in rows if row.explain], [25])

    def test_competing_worker_processes_cannot_both_claim_first_notice(self):
        self.set_limit(1)
        self.reserve("existing")
        context = mp.get_context("fork")
        processes = []
        try:
            for key in ("worker-a", "worker-b"):
                rx, tx = context.Pipe(duplex=False)
                process = context.Process(target=reserve_in_child, args=(key, tx))
                process.start()
                tx.close()
                processes.append((process, rx))
            result = []
            for process, rx in processes:
                self.assertTrue(rx.poll(8))
                result.append(rx.recv())
                process.join(8)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(sorted(result), [(2, True), (3, False)])
        finally:
            for process, rx in processes:
                if process.is_alive():
                    process.terminate()
                    process.join()
                rx.close()

    def test_clock_rollover_and_retry_keep_original_occurrence(self):
        self.set_limit(1)
        instant = self.day.isoformat()
        self.assertEqual(self.reserve("news", scheduled=instant).number, 1)
        current = self.reserve("weather", scheduled=instant)
        self.assertTrue(current.explain)
        self.clock.return_value = self.day + timedelta(days=1)
        retry = self.reserve("weather", execution_id="new-worker-id", scheduled=self.day.astimezone(timezone.utc).isoformat())
        self.assertEqual(retry.number, 2)
        self.assertTrue(retry.exceeded)
        self.assertFalse(retry.explain)
        self.assertEqual(self.reserve("news", scheduled=self.clock.return_value.isoformat()).number, 1)

    def test_native_retry_ladder_reuses_original_reservation(self):
        from cron.occurrences import scheduled_instant
        from cron.unreachable_retry import STATE_KEY

        job = self.jobs.create_job("Новости", "every 2h", name="Новости")
        job["_scheduled_instant"] = scheduled_instant(job["next_run_at"])
        original = self.quota.reserve(job, "first-execution")
        self.assertTrue(self.jobs.mark_job_run(
            job["id"], False, "network", model_unreachable=True, automation_occurrence=original.occurrence,
        ))
        retry = self.jobs.get_job(job["id"])
        retry["_scheduled_instant"] = scheduled_instant(retry[STATE_KEY]["at"])
        result = self.quota.reserve(retry, "second-execution")
        self.assertEqual(result.number, original.number)
        self.assertEqual(self.reserve("unrelated").number, 2)

    def test_per_profile_scope_and_configuration_change(self):
        self.set_limit(1)
        self.reserve("job-a")
        self.assertTrue(self.reserve("job-b").explain)
        self.set_limit(6)
        self.assertFalse(self.reserve("job-c").exceeded)
        self.set_limit(1)
        self.assertFalse(self.reserve("job-d").explain)
        with tempfile.TemporaryDirectory() as second, patch.dict(os.environ, {"HERMES_HOME": second}):
            self.assertEqual(self.reserve("job-a").number, 1)
        self.set_limit(True)
        with self.assertRaises(ValueError):
            self.reserve("bad-config")

    def test_backup_restore_keeps_counter_and_reserved_explanation(self):
        self.set_limit(1)
        self.executions.create_execution("old-format", source="direct")
        self.reserve("first")
        self.assertTrue(self.reserve("over").explain)
        restored = self.home / "restored/cron/executions.db"
        restored.parent.mkdir(parents=True)
        from importlib.util import module_from_spec, spec_from_file_location
        snapshot_script = Path("/usr/local/libexec/brai-dev-user-snapshot.py")
        if snapshot_script.is_file():
            spec = spec_from_file_location("brai_quota_snapshot_tool", snapshot_script)
            snapshot = module_from_spec(spec)
            spec.loader.exec_module(snapshot)
            snapshot.sqlite_snapshot(self.db, restored)
        else:
            with closing(sqlite3.connect(self.db)) as source, closing(sqlite3.connect(restored)) as target:
                source.backup(target)
        with patch.dict(os.environ, {"HERMES_HOME": str(restored.parents[1])}):
            self.assertEqual(self.reserve("over").number, 2)
            self.assertFalse(self.reserve("over").explain)
            self.assertEqual(self.reserve("next").number, 3)

    def test_scheduler_skips_original_model_and_script_after_limit(self):
        self.set_limit(1)
        normal_response = (True, "audit output", "Готово", None)
        reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Можно выпускать сводку реже."))])
        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "worker"}),
            patch.object(self.scheduler, "run_job", return_value=normal_response) as run,
            patch.object(self.scheduler, "_deliver_result", return_value=None) as deliver,
            patch("agent.auxiliary_client.call_llm", return_value=reply) as explain,
        ):
            for i in range(3):
                job = self.jobs.create_job("Original action", "every 1m", name=f"Сводка {i + 1}",
                                           deliver="origin", no_agent=False)
                self.assertTrue(self.scheduler.run_one_job(job))
                if i:
                    self.assertEqual(self.jobs.get_job(job["id"])["last_status"], "quota_skipped")
            run.assert_called_once()
            explain.assert_called_once()
            self.assertTrue(explain.call_args.kwargs["single_attempt"])
            self.assertNotIn("Original action", str(explain.call_args.kwargs["messages"]))
            self.assertIn("нужен админский доступ", deliver.call_args_list[1].args[1])
            self.assertIn("Можно выпускать сводку реже.", deliver.call_args_list[1].args[1])
            self.assertIn("3-е срабатывание", deliver.call_args_list[2].args[1])

    def test_missing_model_response_uses_fixed_notice_and_no_second_model_call(self):
        job = {"id": "weather", "name": "Сводка погоды"}
        with patch("agent.auxiliary_client.call_llm", side_effect=ConnectionError) as model:
            first = self.quota.notice(job, self.quota.Quota(25, 24, True))
            further = self.quota.notice(job, self.quota.Quota(26, 24))
        model.assert_called_once()
        self.assertIn("не более 24 запусков", first)
        self.assertIn("Сегодня использовано 24 из 24 запусков", further)
        self.assertIn("26-е срабатывание", further)

    def test_notice_does_not_start_bot_chat_and_retains_human_destination(self):
        from cron import scheduler_delivery as delivery

        targets = [{"platform": delivery.BOT_CHAT_PLATFORM, "chat_id": "owner"}]
        human = {"platform": "telegram", "chat_id": "123"}
        job = {"id": "report", "deliver": "bot-chat", "_brai_quota_notice": True}
        with (
            patch.object(delivery, "_resolve_delivery_targets", side_effect=[targets, [human]]),
            patch.object(delivery, "_deliver_to_bot_chat") as bot_chat,
            patch.object(delivery, "_prepare_target_delivery", return_value=SimpleNamespace(live_adapter_ready=False)),
            patch.object(delivery, "_deliver_standalone") as send,
            patch("gateway.config.load_gateway_config"),
        ):
            self.assertIsNone(delivery._deliver_result(job, "Сводка пропущена."))
        bot_chat.assert_not_called()
        self.assertEqual(send.call_args.args[1], "Сводка пропущена.")

    def test_reading_full_task_allows_edit_without_losing_existing_settings(self):
        from tools.cronjob_tools import cronjob

        original = "Собирай новости по таким правилам. " * 8 + "Сохрани ссылки на первоисточники."
        job = self.jobs.create_job(original, "every 2h", name="Утренний обзор", deliver="origin")
        read = json.loads(cronjob("get", job_id=job["id"]))
        self.assertEqual(read["job"]["prompt"], original)
        updated = json.loads(cronjob("update", job_id=job["id"], prompt=original + " Исключи спорт."))
        self.assertTrue(updated["success"])
        self.assertEqual(updated["job"]["schedule"], read["job"]["schedule"])
        self.assertEqual(updated["job"]["deliver"], read["job"]["deliver"])

    def test_single_model_attempt_skips_sdk_and_aux_retries(self):
        from agent import auxiliary_client as aux

        sdk = Mock()
        client = sdk.with_options.return_value
        request = SimpleNamespace(client=sdk, kwargs={}, request_provider="test",
                                  resolved_api_mode="chat_completions", base_info=None,
                                  resolved_base_url=None)
        with (
            patch.object(aux, "_plan_aux_call", return_value=(request, {}, {})),
            patch.object(aux, "_relay_sync_completion", side_effect=ConnectionError) as send,
            patch.object(aux, "_start_recovery_ladder") as retry,
        ):
            with self.assertRaises(ConnectionError):
                aux._call_llm_impl(single_attempt=True, messages=[])
        sdk.with_options.assert_called_once_with(max_retries=0)
        self.assertIs(send.call_args.args[0], client)
        send.assert_called_once()
        retry.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
