# ABOUTME: Проверяет суточный лимит на собранном Hermes с настоящим SQLite.
# ABOUTME: Подменяет Auth, модель и внешнюю доставку, не привлекая живые аккаунты.
import importlib
import json
import multiprocessing as mp
import os
import queue
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
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

    def test_provider_hold_reuses_only_a_recovery_of_the_consumed_occurrence(self):
        from cron import quota_hold
        from cron.occurrences import scheduled_instant

        now = self.day.replace(hour=1)
        with (
            patch.object(self.jobs, "_hermes_now", return_value=now),
            patch.object(quota_hold, "_hermes_now", return_value=now),
        ):
            for index, schedule in enumerate(("0 1 * * *", "* * * * *")):
                job = self.jobs.create_job("Новости", schedule, name=f"Новости {index}")
                job["_scheduled_instant"] = scheduled_instant(now.isoformat())
                original = self.quota.reserve(job, f"first-{index}")
                self.assertTrue(self.jobs.mark_job_run(
                    job["id"], False, "provider hold", quota_hold_seconds=300,
                    recover_consumed_fire=True, automation_occurrence=original.occurrence,
                ))
                recovery = self.jobs.get_job(job["id"])
                recovery["_scheduled_instant"] = scheduled_instant(recovery["next_run_at"])
                result = self.quota.reserve(recovery, f"retry-{index}")
                self.assertEqual(result.number, original.number + index)

    def test_chronos_duplicate_before_next_slot_is_not_a_manual_attempt(self):
        from cron.scheduler_provider import CronScheduler

        class ChronosFixture(CronScheduler):
            name = "chronos"

            def start(self, **kwargs):
                return None

        provider = ChronosFixture()
        job = self.jobs.create_job("Новости", "every 1m", name="Новости")
        instant = datetime.fromisoformat(job["next_run_at"])
        with patch.object(self.jobs, "_hermes_now", return_value=instant):
            first = provider.claim_fire(job["id"])
            self.assertIsNotNone(first)
            self.assertTrue(self.jobs.mark_job_run(
                job["id"], True, expected_fire_owner=first["fire_claim"]["by"],
            ))
            self.assertIsNone(provider.claim_fire(job["id"]))
            manual = provider.claim_fire(job["id"], manual=True)
            self.assertIsNotNone(manual)
            self.assertIsNone(manual["_scheduled_instant"])

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

    def test_managed_worker_cannot_turn_off_quota_via_personal_environment(self):
        from cron import scheduler_delivery
        from gateway.config import GatewayConfig

        self.set_limit(0)
        marker = self.home / "profile-config.json"
        marker.write_text("{}")
        job = self.jobs.create_job("Original action", "every 1m", name="Отчёт", deliver="bot-chat")
        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "other", "BRAI_IDENTITY_TELEGRAM_ID": "123"}),
            patch("hermes_constants.BRAI_WORKER_CONFIG_PATH", marker),
            patch.object(self.scheduler, "run_job") as run,
            patch.object(scheduler_delivery, "_prepare_target_delivery", return_value=None) as prepare,
            patch.object(scheduler_delivery, "_deliver_to_bot_chat") as bot_chat,
            patch("gateway.config.load_gateway_config", return_value=GatewayConfig()),
            patch("agent.auxiliary_client.call_llm", side_effect=ConnectionError) as explain,
        ):
            self.assertTrue(self.scheduler.run_one_job(job))
        run.assert_not_called()
        bot_chat.assert_not_called()
        explain.assert_called_once()
        self.assertEqual(prepare.call_args.args[1]["chat_id"], "123")
        self.assertIn("не более 0 запусков", prepare.call_args.kwargs["mirror_text"])

    def test_auth_unavailable_preserves_one_shot_and_does_not_inject_bot_chat(self):
        self.role.side_effect = ConnectionError("Auth unavailable")
        job = self.jobs.create_job("Original action", "in 1m", name="Отчёт", deliver="bot-chat")
        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "worker"}),
            patch.object(self.scheduler, "run_job") as run,
            patch.object(self.scheduler, "_deliver_result") as send,
            patch.object(self.scheduler, "_deliver_crash_failure") as crash_notice,
            patch("agent.auxiliary_client.call_llm") as explain,
        ):
            self.assertTrue(self.scheduler.run_one_job(job))
        run.assert_not_called()
        send.assert_not_called()
        crash_notice.assert_not_called()
        explain.assert_not_called()
        after = self.jobs.get_job(job["id"])
        self.assertEqual(after["repeat"]["completed"], 0)
        self.assertEqual(after["next_run_at"], job["next_run_at"])
        self.assertEqual(self.executions.latest_execution(job["id"])["delivery_outcome"], "quota_unavailable")

    def test_unavailable_auth_and_execution_finish_never_wake_bot_chat(self):
        self.role.side_effect = ConnectionError("Auth unavailable")
        job = self.jobs.create_job("Original action", "every 1m", name="Отчёт", deliver="bot-chat")
        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "worker"}),
            patch.object(self.scheduler, "finish_execution", side_effect=OSError("SQLite unavailable")),
            patch.object(self.scheduler, "run_job") as run,
            patch.object(self.scheduler, "_deliver_crash_failure") as crash_notice,
        ):
            self.assertFalse(self.scheduler.run_one_job(job))
        run.assert_not_called()
        crash_notice.assert_not_called()

    def test_detached_worker_loss_recovers_static_notice_without_model(self):
        from cron.scheduler_worker_failure import record_unknown_worker_outcome

        self.set_limit(0)
        job = self.jobs.create_job("Original action", "every 1m", name="Сводка", deliver="bot-chat")
        claimed = self.jobs.claim_job_for_fire(job["id"], manual=True, return_job=True)
        execution_id = self.executions.create_execution(job["id"], source="direct")["id"]
        claimed["execution_id"] = execution_id
        self.assertIsNotNone(self.executions.mark_execution_running(execution_id))
        self.assertTrue(self.quota.reserve(claimed, execution_id).explain)
        with self.executions._transaction() as conn:
            conn.execute("UPDATE executions SET status='unknown' WHERE id=?", (execution_id,))
        with (
            patch.object(self.scheduler, "_deliver_result", return_value=None) as deliver,
            patch.object(self.scheduler, "_deliver_crash_failure") as crash,
            patch("agent.auxiliary_client.call_llm") as model,
        ):
            self.assertTrue(record_unknown_worker_outcome(claimed))
        crash.assert_not_called()
        model.assert_not_called()
        self.assertTrue(deliver.call_args.args[0]["_brai_quota_notice"])
        self.assertIn("нужен админский доступ", deliver.call_args.args[1])
        self.assertEqual(self.jobs.get_job(job["id"])["last_status"], "quota_skipped")

    def test_background_quota_suppresses_completion_wake(self):
        from tools import async_delegation, cronjob_tools

        self.set_limit(0)
        job = self.jobs.create_job("Original action", "every 1m", name="Сводка")

        def run_now(callback):
            future = Future()
            future.set_result(callback())
            return future

        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "worker"}),
            patch.object(async_delegation, "_records", {}),
            patch.object(async_delegation, "_get_executor", return_value=SimpleNamespace(submit=run_now)),
            patch.object(async_delegation, "_push_completion_event") as wake,
            patch.object(self.scheduler, "run_job") as run,
            patch.object(self.scheduler, "_deliver_result", return_value=None),
            patch("agent.auxiliary_client.call_llm", side_effect=ConnectionError),
        ):
            result = json.loads(cronjob_tools.cronjob("run", job_id=job["id"], session_id="origin"))
            self.assertEqual(result["job"]["execution_mode"], "background")
            with closing(async_delegation._connect()) as conn:
                row = conn.execute(
                    "SELECT state, delivery_state, event_json FROM async_delegations WHERE delegation_id=?",
                    (result["job"]["delegation_id"],),
                ).fetchone()
            self.assertEqual(row, ("completed", "dropped", None))
            self.assertEqual(async_delegation.restore_undelivered_completions(queue.Queue()), 0)
        run.assert_not_called()
        wake.assert_not_called()

    def test_abandoned_managed_manual_run_leaves_recovery_to_cron(self):
        from tools import async_delegation

        for delegation_id, role in (("cron", "cron_run"), ("other", "delegate_task")):
            async_delegation._persist_dispatch({
                "delegation_id": delegation_id, "role": role, "session_key": "origin", "dispatched_at": 1,
            })
        with (
            patch.dict(os.environ, {"BRAI_IDENTITY_MODE": "worker"}),
            patch.object(async_delegation, "_owner_liveness", return_value=lambda *args: False),
        ):
            self.assertEqual(async_delegation.recover_abandoned_delegations(), 2)
        with closing(async_delegation._connect()) as conn:
            rows = conn.execute(
                "SELECT delegation_id, state, delivery_state, event_json IS NULL "
                "FROM async_delegations ORDER BY delegation_id",
            ).fetchall()
        self.assertEqual(rows, [("cron", "unknown", "dropped", 1), ("other", "unknown", "pending", 0)])

    def test_missing_model_response_uses_fixed_notice_and_no_second_model_call(self):
        job = {"id": "weather", "name": "Сводка погоды"}
        with patch("agent.auxiliary_client.call_llm", side_effect=ConnectionError) as model:
            first = self.quota.notice(job, self.quota.Quota(25, 24, True))
            further = self.quota.notice(job, self.quota.Quota(26, 24))
        model.assert_called_once()
        self.assertIn("не более 24 запусков", first)
        self.assertIn("Лимит — 24 запусков в сутки", further)
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

        from openai import OpenAI

        sdk = Mock(spec=OpenAI)
        sdk.max_retries = 2
        client = sdk.with_options.return_value
        wire = client.chat.completions.create
        wire.side_effect = RuntimeError("402: can only afford 2048 tokens")
        request = SimpleNamespace(client=sdk, kwargs={"max_tokens": 3000}, request_provider="openrouter",
                                  resolved_api_mode="chat_completions", base_info=None,
                                  resolved_base_url=None)

        def invoke(transport, kwargs, **params):
            self.assertIs(transport, client)
            return params["create"](kwargs)

        with (
            patch.object(aux, "_plan_aux_call", return_value=(request, {}, {})),
            patch.object(aux, "_relay_sync_completion", side_effect=invoke),
            patch.object(aux, "_create_with_progress") as adjust_tokens,
            patch.object(aux, "_start_recovery_ladder") as retry,
        ):
            with self.assertRaisesRegex(RuntimeError, "402"):
                aux._call_llm_impl(single_attempt=True, messages=[])
        sdk.with_options.assert_called_once_with(max_retries=0)
        wire.assert_called_once_with(max_tokens=3000)
        adjust_tokens.assert_not_called()
        retry.assert_not_called()


    def test_single_attempt_refuses_a_transport_with_implicit_resends(self):
        from agent import auxiliary_client as aux

        request = SimpleNamespace(client=object(), kwargs={}, request_provider="wrapper")
        with (
            patch.object(aux, "_plan_aux_call", return_value=(request, {}, {})),
            patch.object(aux, "_relay_sync_completion") as send,
        ):
            with self.assertRaisesRegex(RuntimeError, "cannot guarantee a single attempt"):
                aux._call_llm_impl(single_attempt=True, messages=[])
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
