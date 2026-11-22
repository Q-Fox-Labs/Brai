# ABOUTME: Проверяет оформление и отмену задач на собранном native Hermes.
# ABOUTME: Использует временное хранилище и подставную доставку, без запросов к моделям и Telegram.
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


@unittest.skipUnless(os.environ.get("BRAI_SCHEDULED_NATIVE_ENGINE"), "Нужен собранный кандидат Hermes")
class ScheduledMessagesTests(unittest.TestCase):
    title = "Новости России и мира"
    digest = "Сегодняшняя сводка."
    instruction = "Чтобы больше не получать такие сообщения, напишите в чат «Отмени задание „Новости России и мира“»."

    def setUp(self):
        from agent import i18n
        from cron import jobs, scheduler_delivery
        from tools import cronjob_tools

        expected = Path(os.environ["BRAI_SCHEDULED_NATIVE_ENGINE"]).resolve()
        self.assertEqual(Path(scheduler_delivery.__file__).resolve().parents[1], expected)
        self.jobs = jobs
        self.delivery = scheduler_delivery
        self.tool = cronjob_tools.cronjob
        home = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(jobs.use_cron_store(home))
        self.enterContext(patch.dict(os.environ, {"HERMES_HOME": home, "HERMES_LANGUAGE": "ru"}))
        i18n.reset_language_cache()

    def create(self, schedule="every 1m", *, name=title, repeat=None):
        return self.jobs.create_job(self.digest, schedule, name=name, repeat=repeat, deliver="origin")

    def render(self, job, content=None, *, failure=False):
        return self.delivery._scheduled_delivery_text(
            job, self.digest if content is None else content, for_failure=failure
        )

    def test_telegram_send_uses_plain_title_and_cancellation_instruction(self):
        job = self.create()
        destination = {"platform": "telegram", "chat_id": "123"}
        with (
            patch.object(self.delivery, "_resolve_delivery_targets", return_value=[destination]),
            patch.object(self.delivery, "_prepare_target_delivery", return_value=SimpleNamespace(live_adapter_ready=False)),
            patch.object(self.delivery, "_deliver_standalone") as send,
            patch.object(self.delivery._sched, "load_config", return_value={}),
            patch("gateway.config.load_gateway_config"),
        ):
            self.assertIsNone(self.delivery._deliver_result(job, self.digest))
        self.assertEqual(send.call_args.args[1], f"{self.title}\n\n{self.digest}\n\n{self.instruction}")
        self.assertNotIn(job["id"], send.call_args.args[1])

    def test_plain_delivery_override_keeps_the_original_response(self):
        job = self.create()
        destination = {"platform": "telegram", "chat_id": "123"}
        with (
            patch.object(self.delivery, "_resolve_delivery_targets", return_value=[destination]),
            patch.object(self.delivery, "_prepare_target_delivery", return_value=SimpleNamespace(live_adapter_ready=False)),
            patch.object(self.delivery, "_deliver_standalone") as send,
            patch.object(self.delivery._sched, "load_config", return_value={"cron": {"wrap_response": False}}),
            patch("gateway.config.load_gateway_config"),
        ):
            self.assertIsNone(self.delivery._deliver_result(job, self.digest))
        self.assertEqual(send.call_args.args[1], self.digest)

    def test_one_shot_final_and_cancelled_tasks_do_not_offer_cancellation(self):
        once = self.create("in 1m")
        final = self.create(repeat=2)
        final["repeat"]["completed"] = 1
        paused = self.create()
        paused["enabled"] = False
        for job in (once, final, paused):
            with self.subTest(schedule=job["schedule"], repeat=job["repeat"], enabled=job["enabled"]):
                self.assertEqual(self.render(job), f"{self.title}\n\n{self.digest}")

    def test_existing_title_and_failure_appear_once(self):
        job = self.create()
        content = f"**{self.title}**\n\n{self.digest}"
        self.assertEqual(self.render(job, content), f"{content}\n\n{self.instruction}")
        failure = f"Не удалось подготовить «{self.title}»."
        self.assertEqual(self.render(job, failure, failure=True), f"{failure}\n\n{self.instruction}")

    def test_untitled_task_does_not_expose_its_id(self):
        job = self.create()
        job["name"] = job["id"]
        self.assertEqual(self.render(job), f"Задание по расписанию\n\n{self.digest}")
        message = self.delivery._sched._summarize_cron_failure_for_delivery(job, "synthetic")
        self.assertNotIn(job["id"], message)

    def test_exact_name_cancellation_prevents_the_next_run(self):
        target = self.create()
        unrelated = self.create(name="Новости науки")
        result = json.loads(self.tool(action="remove", job_id=self.title))
        self.assertEqual(result["removed_job"]["id"], target["id"])
        self.assertIsNone(self.jobs.get_job(target["id"]))
        later = datetime.fromisoformat(target["next_run_at"]) + timedelta(seconds=1)
        with patch.object(self.jobs, "_hermes_now", return_value=later):
            self.assertEqual([job["id"] for job in self.jobs.get_due_jobs()], [unrelated["id"]])

    def test_ambiguous_name_does_not_remove_either_task(self):
        jobs = [self.create(), self.create("every 2m")]
        result = json.loads(self.tool(action="remove", job_id=self.title))
        self.assertFalse(result["success"])
        self.assertEqual({job["id"] for job in result["matches"]}, {job["id"] for job in jobs})
        self.assertTrue(all(self.jobs.get_job(job["id"]) for job in jobs))


if __name__ == "__main__":
    unittest.main(verbosity=2)
