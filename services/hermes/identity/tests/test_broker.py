# ABOUTME: Проверяет UID-bound JSON-RPC broker и привилегированные файловые границы.
# ABOUTME: Использует временные fixtures без модели, сети и live-профилей.
import asyncio
import json
from contextlib import suppress
from pathlib import Path
import os
import socket
import stat
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from services.hermes.identity import broker as broker_module
from services.hermes.identity.broker import Broker


TEMP_ROOT = Path(os.environ["BRAI_BROKER_TMP"])
WORKER_UID = os.getuid()
INGRESS_UID = 995
OTHER_UID = WORKER_UID + 1


def make_profile(uid=WORKER_UID, *, user_id="user-a", profile_id="profile-a",
                 telegram_id="111222", status="active", home="/unused/home"):
    return {
        "userId": user_id,
        "profileId": profile_id,
        "telegramId": telegram_id,
        "status": status,
        "home": home,
    }


class FakeControl:
    def __init__(self, profiles=None):
        self.profiles = profiles or {WORKER_UID: make_profile()}
        self.calls = []
        self.aliases = {}

    async def call(self, method, params, timeout=35):
        self.calls.append((method, dict(params), timeout))
        if method == "authorize":
            profile = self.profiles.get(params.get("uid"))
            if not profile:
                raise PermissionError("synthetic inactive principal")
            return {"userId": profile["userId"], "profileId": profile["profileId"], "role": "user", "generation": 0}
        if method == "identity.resolve":
            telegram_id = params.get("telegramId")
            profile = next((p for p in self.profiles.values()
                            if p["telegramId"] == self.aliases.get(telegram_id, telegram_id) and p["status"] == "active"), None)
            if not profile:
                return {"user": {"id": "unknown", "profileId": "unknown", "telegramId": telegram_id,
                                 "status": "inactive"}}
            return {"user": {"id": profile["userId"], "profileId": profile["profileId"],
                             "telegramId": profile["telegramId"], "status": "active"}}
        if method == "telegram.unlink":
            selected = params.get("targetTelegramId", "333444" if params["target"] == "other" else params["telegramId"])
            if params.get("phase") == "offer":
                return {"status": "needs_consent", "targetTelegramId": selected,
                        "account": {"name": "Второй аккаунт", "username": "second"},
                        "lastChannel": False}
            return {"status": getattr(self, "unlink_status", "sent"), "targetTelegramId": selected}
        if method == "telegram.link":
            if params.get("phase") == "offer":
                return {"status": "needs_consent", "botUrl": "https://t.me/brai_test_bot",
                        "accounts": [{"name": "Владелец", "username": "owner"}]}
            return {"status": getattr(self, "link_status", "sent"), "code": "synthetic-secret-must-not-escape"}
        if method == "login.send":
            return {"status": "sent", "code": "synthetic-code-must-not-escape"}
        if method == "tools.list":
            return {"role": "user", "generation": 0, "tools": []}
        if method == "tools.call":
            return {"ok": True}
        if method == "artifacts.publish":
            return {"artifactId": "synthetic-artifact"}
        return {"ok": True}


class BrokerSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.profile = make_profile()
        self.control = FakeControl({WORKER_UID: self.profile})
        self.config = {
            "registryPath": "unused-registry",
            "ingressUid": INGRESS_UID,
            "stagingRoot": str(TEMP_ROOT / "staging"),
        }
        self.broker = Broker(self.config, self.control)
        self.broker.login_state = broker_module.LoginDeliveryState(':memory:')
        self.addCleanup(self.broker.login_state.close)
        self.broker.profiles = lambda: {WORKER_UID: self.profile}

    async def test_invitation_waits_for_queued_installation_beyond_three_minutes(self):
        self.config['accessCommand'] = ['/synthetic/access']
        user = {'id': 'user-a', 'profileId': 'profile-a', 'telegramId': '111222'}
        polls = 0
        async def control(method, params, timeout=35):
            nonlocal polls
            self.control.calls.append((method, dict(params), timeout))
            if method == 'identity.invite-redeem':
                return {'user': {**user, 'status': 'provisioning'}}
            self.assertEqual(method, 'identity.resolve')
            polls += 1
            return {'user': {**user, 'status': 'active' if polls > 100 else 'provisioning'}}
        self.control.call = control
        with mock.patch.object(broker_module.asyncio, 'sleep', new_callable=mock.AsyncMock) as sleep, \
             mock.patch.object(broker_module.asyncio, 'create_subprocess_exec', side_effect=AssertionError('direct install')):
            result = await self.broker.call(INGRESS_UID, 'identity.invite-redeem',
                {'telegramId': '111222', 'code': 'synthetic'})
        self.assertEqual(result['uid'], WORKER_UID)
        self.assertEqual(sleep.await_count, 100)
        self.assertTrue(all(call.args == (2,) for call in sleep.await_args_list))

    async def test_invitation_revocation_during_queued_installation_denies_access(self):
        self.config['accessCommand'] = ['/synthetic/access']
        user = {'id': 'user-a', 'profileId': 'profile-a', 'telegramId': '111222'}
        polls = 0
        async def control(method, params, timeout=35):
            nonlocal polls
            if method == 'identity.invite-redeem':
                return {'user': {**user, 'status': 'provisioning'}}
            self.assertEqual(method, 'identity.resolve')
            polls += 1
            return {'user': {**user, 'status': 'blocked' if polls == 101 else 'provisioning'}}
        self.control.call = control
        with mock.patch.object(broker_module.asyncio, 'sleep', new_callable=mock.AsyncMock), \
             mock.patch.object(broker_module.asyncio, 'create_subprocess_exec', side_effect=AssertionError('direct install')):
            with self.assertRaisesRegex(PermissionError, 'Invitation unavailable'):
                await self.broker.call(INGRESS_UID, 'identity.invite-redeem',
                    {'telegramId': '111222', 'code': 'synthetic'})
        self.assertEqual(polls, 101)

    async def test_account_rebinding_race_is_denied_before_registering_wrong_worker(self):
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.admit', {'telegramId': '111222',
                'chatId': '111222', 'privateChat': True, 'turnId': 'race', 'expectedUid': OTHER_UID})
        self.assertFalse(self.broker.turns)

    async def test_account_alias_resolves_same_owner_and_revocation_blocks_active_delivery(self):
        self.control.aliases['333444'] = '111222'
        primary = await self.broker.resolve('111222')
        alias = await self.broker.resolve('333444')
        self.assertEqual(primary['uid'], alias['uid'])
        self.assertEqual(primary['profileId'], alias['profileId'])
        self.assertEqual(alias['telegramId'], '333444')
        self.assertEqual(alias['authorTelegramId'], '111222')
        await self.broker.call(INGRESS_UID, 'ingress.admit', {
            'telegramId': '333444', 'chatId': '333444', 'privateChat': True, 'turnId': 'alias-turn'})
        result = await self.broker.call(WORKER_UID, 'login.send', {})
        self.assertEqual(result['status'], 'sent')
        sent = next(params for method, params, _ in self.control.calls if method == 'login.send')
        self.assertEqual(sent['telegramId'], '333444')
        del self.control.aliases['333444']
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.status', {'uid': WORKER_UID, 'turnId': 'alias-turn'})

    async def _account_offer(self, method="telegram.link", *, turn="offer", digit="a", message="101", target="other"):
        original = {"telegramId": "111222", "chatId": "111222", "privateChat": True,
                    "turnId": turn, "inputId": digit * 64, "messageId": message}
        await self.broker.call(INGRESS_UID, "ingress.admit", original)
        result = await self.broker.call(WORKER_UID, method, {"target": target} if method == "telegram.unlink" else {})
        self.assertEqual(result["status"], "needs_consent")
        self.assertIs(result["suppressFinal"], False)
        status = await self.broker.call(INGRESS_UID, "ingress.status", {"uid": WORKER_UID, "turnId": turn})
        self.assertIs(status.get("needsAccountConsent"), True)
        return original, result

    async def _close_question(self, original, question="102"):
        params = {"uid": WORKER_UID, "turnId": original["turnId"], "inputId": original["inputId"]}
        if question is not None:
            status = await self.broker.call(INGRESS_UID, "ingress.status", params)
            params["questionMessageId"] = question
            if status.get("accountOfferId"):
                params["accountOfferId"] = status["accountOfferId"]
        await self.broker.call(INGRESS_UID, "ingress.close", params)

    async def _answer_question(self, original, *, text="Подтверждаю", turn="confirm",
                               message="103", digit="b", **changes):
        current = {**original, "turnId": turn, "inputId": digit * 64,
                   "messageId": message, "accountAnswer": text, **changes}
        await self.broker.call(INGRESS_UID, "ingress.admit", current)
        return current

    def _account_mutations(self):
        return [(method, params) for method, params, _ in self.control.calls
                if method in ("telegram.link", "telegram.unlink") and params["phase"] != "offer"]

    async def test_account_link_waits_for_delivered_question_and_exact_full_new_answer(self):
        answer = " Да, я понимаю общий доступ к памяти и файлам. Подключите мой второй личный аккаунт.\n"
        original, first = await self._account_offer()
        self.assertEqual(first["botUrl"], "https://t.me/brai_test_bot")
        self.assertNotIn("code", first)
        await self._close_question(original)
        await self._answer_question(original, text=answer)
        args = {"message": "Перейдите во второй аккаунт.", "confirmation": answer}
        final = await self.broker.call(WORKER_UID, "telegram.link", args)
        self.assertEqual(final, {"status": "sent", "phase": "command", "suppressFinal": True})
        self.assertNotIn("synthetic-secret", json.dumps(final))
        await self.broker.call(WORKER_UID, "telegram.link", args)
        self.assertEqual(len(self._account_mutations()), 1)
        self.assertEqual(self._account_mutations()[0][1]["message"], args["message"])
        self.assertNotIn("confirmation", self._account_mutations()[0][1])
        self.assertFalse(self.broker.link_offers)

    async def test_link_confirmation_rejects_undelivered_wrong_context_refusal_and_old_messages(self):
        self.control.aliases["333444"] = "111222"
        variants = ["undelivered", "account", "topic", "expired", "no-answer", "refused",
                    "replayed", "edited", "before-question", "chat"]
        for index, changed in enumerate(variants):
            with self.subTest(changed=changed):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                original, _ = await self._account_offer(turn=changed, digit=format(index + 1, "x"), message="201")
                await self._close_question(original, None if changed == "undelivered" else "202")
                if changed == "expired":
                    self.broker.link_offers[WORKER_UID]["expires"] = 0
                account = "333444" if changed == "account" else "111222"
                await self._answer_question(original, text="" if changed == "no-answer" else "Разрешаю подключить второй аккаунт",
                    turn=changed + "-next", message="201" if changed == "edited" else "202" if changed == "before-question" else "203",
                    telegramId=account, chatId="333444" if changed == "chat" else account,
                    threadId=7 if changed == "topic" else None,
                    inputId=original["inputId"] if changed == "replayed" else "f" * 64,
                    accountRefused=changed == "refused")
                if changed == "chat":
                    with self.assertRaisesRegex(PermissionError, "Private Telegram turn required"):
                        await self.broker.call(WORKER_UID, "telegram.link",
                            {"message": "Вступление", "confirmation": "Разрешаю подключить второй аккаунт"})
                    continue
                result = await self.broker.call(WORKER_UID, "telegram.link",
                    {"message": "Вступление", "confirmation": "Разрешаю подключить второй аккаунт"})
                self.assertEqual(result["status"], "denied")
                self.assertEqual(result["reason"], "consent-refused" if changed == "refused" else "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_confirmation_must_equal_whole_trusted_text_without_normalization_or_substring(self):
        answer = " Да, разрешаю.\n"
        original, _ = await self._account_offer()
        await self._close_question(original)
        await self._answer_question(original, text=answer)
        for supplied in ["Да, разрешаю.", "разрешаю", answer.upper(), answer + "ещё", "Подтверждаю"]:
            with self.subTest(supplied=supplied):
                before = [call for call in self.control.calls if call[0] == "telegram.link"]
                denied = await self.broker.call(WORKER_UID, "telegram.link",
                    {"message": "Вступление", "confirmation": supplied})
                self.assertEqual(denied["reason"], "confirmation-mismatch")
                self.assertEqual([call for call in self.control.calls if call[0] == "telegram.link"], before)
        self.assertFalse(self._account_mutations())
        self.assertEqual((await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": answer}))["status"], "sent")

    async def test_provenance_does_not_classify_answer_or_execute_without_agent_confirmation(self):
        # Эти формы агент обязан семантически отвергнуть; broker не является классификатором.
        for index, answer in enumerate(["Да, но только если данные не будут общими",
                                        "Он сказал: «подтверждаю»", "Нужно ли мне подтвердить?"]):
            with self.subTest(answer=answer):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                original, _ = await self._account_offer(turn="semantic-" + str(index), digit=str(index + 1))
                await self._close_question(original)
                await self._answer_question(original, text=answer, turn="semantic-answer-" + str(index))
                self.assertEqual(self.broker.turns[WORKER_UID]["accountAnswer"], answer)
                self.assertEqual(self.broker.turns[WORKER_UID]["accountAction"], "link")
                self.assertFalse(self._account_mutations())
                # Повторный read-only offer отменяет candidate, даже с тем же новым ответом.
                offered = await self.broker.call(WORKER_UID, "telegram.link", {})
                self.assertEqual(offered["status"], "needs_consent")
                denied = await self.broker.call(WORKER_UID, "telegram.link",
                    {"message": "Вступление", "confirmation": answer})
                self.assertEqual(denied["reason"], "confirmation-unavailable")
                self.assertFalse(self._account_mutations())

    async def test_new_human_input_consumes_pending_offer_and_candidate_cannot_move_to_later_input(self):
        original, _ = await self._account_offer()
        await self._close_question(original)
        first = await self._answer_question(original, text="А какие данные?", turn="question")
        self.assertFalse(self.broker.link_offers)
        await self._close_question(first, None)
        await self._answer_question(original, text="Да, подключайте", turn="later", message="105", digit="c")
        denied = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Да, подключайте"})
        self.assertEqual(denied["reason"], "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_empty_media_input_consumes_pending_offer_without_confirming(self):
        original, _ = await self._account_offer()
        await self._close_question(original)
        media = await self._answer_question(original, text="", turn="media")
        self.assertFalse(self.broker.link_offers)
        await self._close_question(media, None)
        await self._answer_question(original, text="Подтверждаю", turn="later", message="106", digit="c")
        self.assertEqual((await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Подтверждаю"}))["reason"], "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_offer_without_confirmation_rechecks_control_and_cancels_previous_candidate(self):
        original, _ = await self._account_offer()
        await self._close_question(original)
        await self._answer_question(original, text="Подключайте мой второй аккаунт")
        for _ in range(2):
            self.assertEqual((await self.broker.call(WORKER_UID, "telegram.link", {}))["status"], "needs_consent")
        self.assertEqual(sum(m == "telegram.link" and p["phase"] == "offer" for m, p, _ in self.control.calls), 3)
        denied = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Подключайте мой второй аккаунт"})
        self.assertEqual(denied["reason"], "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_candidate_expiry_is_checked_again_at_execution(self):
        original, _ = await self._account_offer()
        await self._close_question(original)
        await self._answer_question(original)
        self.broker.turns[WORKER_UID]["accountExpires"] = 0
        before = [call for call in self.control.calls if call[0] == "telegram.link"]
        result = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Подтверждаю"})
        self.assertEqual(result["reason"], "confirmation-unavailable")
        self.assertEqual([call for call in self.control.calls if call[0] == "telegram.link"], before)

    async def test_unknown_command_delivery_does_not_repeat_or_authorize_another_command(self):
        original, _ = await self._account_offer(turn="unknown-offer", digit="1", message="301")
        await self._close_question(original, "302")
        current = await self._answer_question(original, turn="unknown-command", message="303", digit="2")
        self.control.link_status = "unknown"
        args = {"message": "Вступление", "confirmation": "Подтверждаю"}
        result = await self.broker.call(WORKER_UID, "telegram.link", args)
        self.assertEqual(result["status"], "unknown")
        await self.broker.call(WORKER_UID, "telegram.link", args)
        self.assertEqual(len(self._account_mutations()), 1)
        await self._close_question(current, None)
        self.control.link_status = "sent"
        await self._answer_question(current, turn="after-unknown", message="304", digit="3")
        self.assertEqual((await self.broker.call(WORKER_UID, "telegram.link", args))["reason"], "confirmation-unavailable")

    async def test_editing_original_human_input_cannot_confirm_question_edited_in_older_bot_message(self):
        for index, (human_id, confirmed) in enumerate([("801", False), ("803", True)]):
            with self.subTest(human_id=human_id):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                original, _ = await self._account_offer(turn="older-bot-" + str(index),
                    digit=format(index + 9, "x"), message="801")
                await self._close_question(original, "800")
                await self._answer_question(original, turn="older-bot-confirm-" + str(index),
                    digit=format(index + 11, "x"), message=human_id)
                result = await self.broker.call(WORKER_UID, "telegram.link",
                    {"message": "Откройте второй аккаунт.", "confirmation": "Подтверждаю"})
                self.assertEqual(result["status"], "sent" if confirmed else "denied")
                if not confirmed:
                    self.assertEqual(result["reason"], "confirmation-unavailable")

    async def test_question_delivery_metadata_requires_positive_real_message_id_from_ingress(self):
        original, _ = await self._account_offer(turn="invalid-question", digit="9", message="901")
        for question_id in [True, 902, "0", "-1", "bad", "9" * 21]:
            with self.subTest(question_id=question_id), self.assertRaises((ValueError, TypeError)):
                await self._close_question(original, question_id)
        self.assertFalse(self.broker.link_offers[WORKER_UID].get("delivered", False))
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "ingress.close",
                {"uid": WORKER_UID, "turnId": original["turnId"], "questionMessageId": "902"})

    async def test_invalid_introduction_does_not_claim_or_consume_confirmed_delivery(self):
        original, _ = await self._account_offer(turn="bad-intro", digit="7", message="701")
        await self._close_question(original, "702")
        await self._answer_question(original, turn="bad-intro-confirm", digit="8", message="703")
        for message in ["https://t.me/another_bot", "@another_bot", "/start", ""]:
            result = await self.broker.call(WORKER_UID, "telegram.link",
                {"message": message, "confirmation": "Подтверждаю"})
            self.assertEqual(result["status"], "needs_instruction")
        self.assertFalse(self._account_mutations())
        sent = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Откройте второй аккаунт.", "confirmation": "Подтверждаю"})
        self.assertEqual(sent["status"], "sent")
        self.assertEqual(len(self._account_mutations()), 1)

    async def test_account_link_rejects_forged_tool_confirmation_arguments(self):
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "telegram.link", {"confirmed": True})
        await self.broker.call(INGRESS_UID, "ingress.admit",
            {"telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "no-offer"})
        result = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Разрешаю"})
        self.assertEqual(result["reason"], "confirmation-unavailable")
        self.assertFalse(any(method == "telegram.link" for method, _, _ in self.control.calls))

    async def test_unlink_pins_id_and_accepts_exact_full_answer_after_question_delivery(self):
        for index, answer in enumerate(["Да, отвяжите именно второй аккаунт. Я понимаю последствия.",
                                         "Подтверждаю отвязку Telegram-аккаунта 333444"]):
            with self.subTest(answer=answer):
                self.broker.turns.clear()
                self.broker.unlink_offers.clear()
                original, _ = await self._account_offer("telegram.unlink", turn="unlink-" + str(index),
                    digit=str(index + 4), message="401")
                await self._close_question(original, "402")
                await self._answer_question(original, text=answer, turn="unlink-confirm-" + str(index),
                    digit=str(index + 6), message="403")
                args = {"target": "other", "confirmation": answer}
                result = await self.broker.call(WORKER_UID, "telegram.unlink", args)
                self.assertEqual(result, {"status": "sent", "phase": "confirm", "suppressFinal": True})
                params = self._account_mutations()[-1][1]
                self.assertEqual(params["targetTelegramId"], "333444")
                self.assertNotIn("confirmation", params)
                self.assertFalse(self.broker.unlink_offers)
                await self.broker.call(WORKER_UID, "telegram.unlink", args)
                self.assertEqual(sum(m == "telegram.unlink" and p["phase"] == "confirm"
                                     for m, p, _ in self.control.calls), index + 1)

    async def test_unlink_rejects_target_switch_context_expiry_refusal_replay_and_missing_question(self):
        self.control.aliases["333444"] = "111222"
        variants = ["target", "account", "topic", "expired", "no-answer", "refused", "replayed", "undelivered", "edited", "before-question"]
        for index, changed in enumerate(variants):
            with self.subTest(changed=changed):
                self.broker.turns.clear()
                self.broker.unlink_offers.clear()
                original, _ = await self._account_offer("telegram.unlink", turn=changed,
                    digit=format(index + 1, "x"), message="501", target="current")
                await self._close_question(original, None if changed == "undelivered" else "502")
                if changed == "expired":
                    self.broker.unlink_offers[WORKER_UID]["expires"] = 0
                account = "333444" if changed == "account" else "111222"
                await self._answer_question(original, text="" if changed == "no-answer" else "Отвяжите этот аккаунт",
                    turn=changed + "-next", telegramId=account, chatId=account,
                    inputId=original["inputId"] if changed == "replayed" else "e" * 64,
                    threadId=7 if changed == "topic" else None,
                    message="501" if changed == "edited" else "502" if changed == "before-question" else "503",
                    accountRefused=changed == "refused")
                result = await self.broker.call(WORKER_UID, "telegram.unlink",
                    {"target": "other" if changed == "target" else "current", "confirmation": "Отвяжите этот аккаунт"})
                self.assertEqual(result["status"], "denied")
                self.assertEqual(result["reason"], "consent-refused" if changed == "refused" else "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_new_account_action_cancels_other_offer_and_cannot_reuse_its_answer(self):
        original, _ = await self._account_offer(turn="switch-action", digit="1", message="601")
        result = await self.broker.call(WORKER_UID, "telegram.unlink", {"target": "other"})
        self.assertEqual(result["status"], "needs_consent")
        await self._close_question(original, "602")
        await self._answer_question(original, turn="switch-confirm", digit="2", message="603")
        result = await self.broker.call(WORKER_UID, "telegram.link",
            {"message": "Вступление", "confirmation": "Подтверждаю"})
        self.assertEqual(result["reason"], "confirmation-unavailable")
        # Новый вопрос другого действия отменяет и полученный unlink candidate.
        await self.broker.call(WORKER_UID, "telegram.link", {})
        result = await self.broker.call(WORKER_UID, "telegram.unlink",
            {"target": "other", "confirmation": "Подтверждаю"})
        self.assertEqual(result["reason"], "confirmation-unavailable")
        self.assertFalse(self._account_mutations())

    async def test_unlink_cannot_be_called_by_ingress_or_with_foreign_owner_or_legacy_boolean(self):
        for actor, method, params in [
            (INGRESS_UID, "identity.unlink", {"telegramId": "111222"}),
            (INGRESS_UID, "telegram.unlink", {"target": "current"}),
            (WORKER_UID, "telegram.unlink", {"target": "current", "confirmed": True}),
            (WORKER_UID, "telegram.unlink", {"target": "999999"}),
        ]:
            with self.assertRaises(PermissionError):
                await self.broker.call(actor, method, params)
        self.assertFalse(any(m == "telegram.unlink" for m, _, _ in self.control.calls))

    def test_account_confirmation_rpc_contract_rejects_oversize_nonstrings_and_legacy_flags(self):
        for value in [True, 123, [], {}, None, "x" * 8193]:
            for method, base, key in [
                ("ingress.admit", {"telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "a"}, "accountAnswer"),
                ("telegram.link", {}, "confirmation"),
                ("telegram.unlink", {"target": "current"}, "confirmation")]:
                with self.subTest(method=method, value_type=type(value).__name__), self.assertRaises(ValueError):
                    broker_module.validate_params(method, {**base, key: value})
        for flag in ["linkConsent", "unlinkConsent"]:
            with self.assertRaises(ValueError):
                broker_module.validate_params("ingress.admit",
                    {"telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "a", flag: True})

    async def test_waiting_confirmation_cannot_execute_after_turn_closed_or_replaced(self):
        for method in ["telegram.link", "telegram.unlink"]:
            for replacement in [False, True]:
                with self.subTest(method=method, replacement=replacement):
                    self.broker.turns.clear()
                    self.broker.link_offers.clear()
                    self.broker.unlink_offers.clear()
                    original, _ = await self._account_offer(method, turn="locked-offer")
                    await self._close_question(original)
                    current = await self._answer_question(original, turn="locked-answer")
                    args = {"confirmation": "Подтверждаю", **(
                        {"message": "Откройте второй аккаунт."} if method == "telegram.link" else {"target": "other"})}
                    lock = self.broker.login_locks.setdefault(WORKER_UID, asyncio.Lock())
                    await lock.acquire()
                    task = asyncio.create_task(self.broker.call(WORKER_UID, method, args))
                    try:
                        await asyncio.sleep(0)
                        self.assertFalse(task.done())
                        await self._close_question(current, None)
                        if replacement:
                            await self._answer_question(original, text="Нет", turn="new-refusal",
                                message="105", digit="c", accountRefused=True)
                    finally:
                        lock.release()
                    with self.assertRaisesRegex(PermissionError, "Owner turn changed"):
                        await task
                    self.assertFalse(self._account_mutations())

    async def test_offer_result_cannot_install_pending_question_after_awaited_turn_changed(self):
        original_call = self.control.call
        for method in ["telegram.link", "telegram.unlink"]:
            with self.subTest(method=method):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                self.broker.unlink_offers.clear()
                original = {"telegramId": "111222", "chatId": "111222", "privateChat": True,
                    "turnId": "delayed-offer", "inputId": "a" * 64, "messageId": "101"}
                await self.broker.call(INGRESS_UID, "ingress.admit", original)
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed(operation, params, timeout=35):
                    if operation == method and params.get("phase") == "offer":
                        entered.set()
                        await release.wait()
                    return await original_call(operation, params, timeout)
                self.control.call = delayed
                task = asyncio.create_task(self.broker.call(WORKER_UID, method,
                    {"target": "other"} if method == "telegram.unlink" else {}))
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    await self._close_question(original, None)
                    await self._answer_question(original, text="Нет", turn="after-delayed-offer",
                        message="103", digit="b", accountRefused=True)
                finally:
                    release.set()
                try:
                    with self.assertRaisesRegex(PermissionError, "Owner turn changed"):
                        await task
                finally:
                    self.control.call = original_call
                self.assertFalse(self.broker.link_offers)
                self.assertFalse(self.broker.unlink_offers)
                self.assertFalse(self._account_mutations())

    async def test_rpc_waiting_authorize_cannot_adopt_new_turn_with_same_answer(self):
        original_call = self.control.call
        for method in ["telegram.link", "telegram.unlink"]:
            with self.subTest(method=method):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                self.broker.unlink_offers.clear()
                original, _ = await self._account_offer(method, turn="authorize-old")
                await self._close_question(original)
                current = await self._answer_question(original, text="да", turn="authorize-old-answer")
                entered, release = asyncio.Event(), asyncio.Event()
                old_task = None
                async def delayed(operation, params, timeout=35):
                    if operation == "authorize" and asyncio.current_task() is old_task:
                        entered.set()
                        await release.wait()
                    return await original_call(operation, params, timeout)
                self.control.call = delayed
                args = {"confirmation": "да", **(
                    {"message": "Откройте второй аккаунт."} if method == "telegram.link" else {"target": "other"})}
                old_task = asyncio.create_task(self.broker.call(WORKER_UID, method, args))
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    await self._close_question(current, None)
                    new_offer, _ = await self._account_offer(method, turn="authorize-new",
                        digit="c", message="105")
                    await self._close_question(new_offer, "106")
                    await self._answer_question(new_offer, text="да", turn="authorize-new-answer",
                        digit="d", message="107")
                finally:
                    release.set()
                try:
                    with self.assertRaisesRegex(PermissionError, "Owner turn changed"):
                        await old_task
                finally:
                    self.control.call = original_call
                self.assertFalse(self._account_mutations())
                self.assertEqual((await self.broker.call(WORKER_UID, method, args))["status"], "sent")
                self.assertEqual(len(self._account_mutations()), 1)
                self.control.calls.clear()

    async def test_old_question_receipt_cannot_deliver_replaced_offer_or_close_new_input(self):
        for method in ["telegram.link", "telegram.unlink"]:
            with self.subTest(method=method):
                self.broker.turns.clear()
                self.broker.link_offers.clear()
                self.broker.unlink_offers.clear()
                original, _ = await self._account_offer(method)
                query = {"uid": WORKER_UID, "turnId": original["turnId"], "inputId": original["inputId"]}
                old_id = (await self.broker.call(INGRESS_UID, "ingress.status", query))["accountOfferId"]
                await self.broker.call(WORKER_UID, method, {"target": "other"} if method == "telegram.unlink" else {})
                new_id = (await self.broker.call(INGRESS_UID, "ingress.status", query))["accountOfferId"]
                self.assertNotEqual(old_id, new_id)
                await self.broker.call(INGRESS_UID, "ingress.close",
                    {**query, "questionMessageId": "102", "accountOfferId": old_id})
                self.assertNotIn(WORKER_UID, self.broker.turns)
                await self._answer_question(original, turn="old-receipt-answer")
                args = {"confirmation": "Подтверждаю", **(
                    {"message": "Откройте второй аккаунт."} if method == "telegram.link" else {"target": "other"})}
                self.assertEqual((await self.broker.call(WORKER_UID, method, args))["reason"], "confirmation-unavailable")
                current = self.broker.turns[WORKER_UID]
                with self.assertRaises(PermissionError):
                    await self.broker.call(INGRESS_UID, "ingress.close",
                        {**query, "questionMessageId": "102", "accountOfferId": new_id})
                self.assertIs(self.broker.turns[WORKER_UID], current)
                self.assertFalse(self._account_mutations())

    async def test_worker_cannot_manage_telegram_account_bindings(self):
        for method in ['identity.link-issue', 'identity.link-redeem', 'identity.unlink']:
            with self.subTest(method=method), self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, method, {'telegramId': '111222'})

    async def test_worker_cannot_choose_uid_or_call_root_and_ingress_methods(self):
        before = len(self.control.calls)
        with self.assertRaises((PermissionError, ValueError)):
            await self.broker.call(WORKER_UID, "tools.call", {
                "uid": OTHER_UID, "name": "synthetic_tool", "args": {},
            })
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "tools.list", {"uid": OTHER_UID})

        for method, params in (
            ("authorize", {"uid": WORKER_UID}),
            ("identity.resolve", {"telegramId": "111222"}),
            ("identity.invite-redeem", {"telegramId": "111222", "code": "synthetic"}),
            ("ingress.admit", {"telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "turn"}),
        ):
            with self.subTest(method=method), self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, method, params)
        self.assertFalse(any(method == "tools.call" and params.get("uid") == OTHER_UID
                             for method, params, _timeout in self.control.calls[before:]))

        ingress_before = len(self.control.calls)
        for method, params in (
            ("authorize", {"uid": WORKER_UID}),
            ("tools.call", {"uid": WORKER_UID, "name": "synthetic_tool", "args": {}}),
            ("identity.invite-redeem", {"telegramId": "111222", "code": "synthetic", "uid": WORKER_UID}),
        ):
            with self.subTest(ingress_method=method), self.assertRaises((PermissionError, ValueError)):
                await self.broker.call(INGRESS_UID, method, params)
        self.assertFalse(any(method in {"authorize", "tools.call", "identity.invite-redeem"}
                             for method, _params, _timeout in self.control.calls[ingress_before:]))

    async def test_inactive_auth_profile_is_denied_before_control_or_tools(self):
        self.profile["status"] = "suspended"
        with self.assertRaises(PermissionError):
            await self.broker.authorize(WORKER_UID)
        self.assertEqual(self.control.calls, [])

    async def test_login_requires_registered_private_dm_and_returns_only_suppression(self):
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "login.send", {})
        self.assertFalse(any(method == "login.send" for method, _params, _timeout in self.control.calls))

        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, "ingress.admit", {
                "telegramId": "999999", "chatId": "999999", "privateChat": True, "turnId": "unregistered",
            })
        self.assertFalse(self.broker.turns)

        admitted = await self.broker.call(INGRESS_UID, "ingress.admit", {
            "telegramId": "111222", "chatId": "-100", "privateChat": False, "turnId": "group-turn",
        })
        self.assertEqual(admitted["uid"], WORKER_UID)
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, "login.send", {})
        self.assertFalse(any(method == "login.send" for method, _params, _timeout in self.control.calls))

        await self.broker.call(INGRESS_UID, "ingress.close", {"uid": WORKER_UID, "turnId": "group-turn"})
        await self.broker.call(INGRESS_UID, "ingress.admit", {
            "telegramId": "111222", "chatId": "111222", "privateChat": True, "turnId": "private-turn",
        })
        result = await self.broker.call(WORKER_UID, "login.send", {})
        self.assertEqual(result, {"status": "sent", "suppressFinal": True})
        self.assertNotIn("code", result)
        self.assertTrue(self.broker.turns[WORKER_UID]["suppressFinal"])
        sent = [call for call in self.control.calls if call[0] == "login.send"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1], {
            "uid": WORKER_UID, "telegramId": "111222", "privateChat": True,
            "requestId": self.broker.turns[WORKER_UID]["requestId"],
        })
        status = await self.broker.call(INGRESS_UID, "ingress.status", {
            "uid": WORKER_UID, "turnId": "private-turn",
        })
        self.assertEqual(status, {"suppressFinal": True, "needsAccountConsent": False})

    def _publish_fixture(self, filename="file.bin"):
        root = Path(tempfile.mkdtemp(prefix="broker-publish-", dir=TEMP_ROOT))
        home = root / "home"
        workspace = home / "workspace"
        workspace.mkdir(parents=True, mode=0o700)
        source = workspace / filename
        source.write_bytes(b"synthetic-file")
        self.profile["home"] = str(home)
        staging_uid = Path(self.config["stagingRoot"]) / str(WORKER_UID)
        original_lstat = Path.lstat

        def fake_lstat(path):
            if path == staging_uid:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
            return original_lstat(path)

        return root, source, staging_uid, fake_lstat

    async def _assert_publish_rejected(self, path, *, patches=()):
        before = len(self.control.calls)
        params = {"path": str(path), "requestId": "synthetic-request"}
        with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=patches[0] if patches else lambda path: Path.lstat(path)):
            with self.assertRaises((PermissionError, OSError)):
                await self.broker.publish(WORKER_UID, self.profile, params)
        self.assertFalse(any(method == "artifacts.publish" for method, _params, _timeout in self.control.calls[before:]))

    async def test_strict_profile_inventory_fails_instead_of_hiding_auth_error(self):
        result = await self.broker.call(INGRESS_UID, 'ingress.profiles-strict', {})
        self.assertEqual(result['profiles'][0]['uid'], WORKER_UID)
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'ingress.profiles-strict', {})
        with mock.patch.object(self.control, 'call', side_effect=PermissionError('synthetic Auth outage')):
            with self.assertRaises(PermissionError):
                await self.broker.call(INGRESS_UID, 'ingress.profiles-strict', {})

    async def test_preack_identity_distinguishes_null_inactive_alias_and_failure(self):
        params = {'telegramId': '333444'}
        self.control.aliases['333444'] = self.profile['telegramId']
        receipt = await self.broker.call(INGRESS_UID, 'ingress.resolve-known', params)
        self.assertEqual(receipt['state'], 'known')
        self.assertEqual(receipt['profile']['uid'], WORKER_UID)
        self.assertEqual(receipt['profile']['telegramId'], '333444')
        self.assertEqual(receipt['profile']['authorTelegramId'], self.profile['telegramId'])
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'ingress.resolve-known', params)
        with self.assertRaises(ValueError):
            await self.broker.call(INGRESS_UID, 'ingress.resolve-known', {**params, 'extra': True})
        async def null(*args, **kwargs): return {'user': None}
        with mock.patch.object(self.control, 'call', side_effect=null):
            self.assertEqual(await self.broker.call(INGRESS_UID, 'ingress.resolve-known', params), {'state':'unregistered'})
        async def inactive(*args, **kwargs):
            return {'user': {'id':'user', 'profileId':'profile', 'telegramId':'111222', 'status':'blocked'}}
        with mock.patch.object(self.control, 'call', side_effect=inactive):
            self.assertEqual(await self.broker.call(INGRESS_UID, 'ingress.resolve-known', params), {'state':'forbidden'})
        for answer in ({}, {'user': {}}, {'user': 'bad'}):
            with mock.patch.object(self.control, 'call', return_value=answer):
                with self.assertRaises(ValueError):
                    await self.broker.call(INGRESS_UID, 'ingress.resolve-known', params)
        with mock.patch.object(self.control, 'call', side_effect=PermissionError('synthetic outage')):
            with self.assertRaises(PermissionError):
                await self.broker.call(INGRESS_UID, 'ingress.resolve-known', params)

    async def test_preack_identity_rechecks_alias_after_authorization(self):
        initial = {'id':self.profile['userId'], 'profileId':self.profile['profileId'],
                   'telegramId':self.profile['telegramId'], 'status':'active'}
        changed = {**initial, 'status':'blocked'}
        async def control(method, params, timeout=35):
            if method == 'identity.resolve':
                control.reads += 1
                return {'user': initial if control.reads == 1 else changed}
            return {'userId':initial['id'], 'profileId':initial['profileId'], 'role':'user'}
        control.reads = 0
        with mock.patch.object(self.control, 'call', side_effect=control):
            with self.assertRaisesRegex(PermissionError, 'binding changed'):
                await self.broker.call(INGRESS_UID, 'ingress.resolve-known', {'telegramId':'111222'})

    async def test_profile_inventory_is_ingress_only_and_keeps_stable_owner(self):
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'ingress.profiles', {})
        inventory = await self.broker.call(INGRESS_UID, 'ingress.profiles', {})
        self.assertEqual(inventory['profiles'], [{'uid': WORKER_UID, **self.profile, 'role': 'user', 'generation': 0}])
        self.control.aliases['333444'] = self.profile['telegramId']
        actual = await self.broker.resolve('333444')
        self.assertEqual(actual['telegramId'], '333444')
        self.assertEqual(actual['authorTelegramId'], self.profile['telegramId'])
        self.assertEqual((await self.broker.call(INGRESS_UID, 'ingress.profiles', {}))['profiles'],
                         [{'uid': WORKER_UID, **self.profile, 'role': 'user', 'generation': 0}])
        self.profile['status'] = 'blocked'
        self.assertEqual(await self.broker.call(INGRESS_UID, 'ingress.profiles', {}), {'profiles': []})

    async def test_open_artifact_requires_ingress_and_current_owner(self):
        params = {'uid': WORKER_UID, 'artifactId': '6aad00bf-f419-4dda-a61c-7cab79c8c9b0'}
        fd = os.open(__file__, os.O_RDONLY)
        with mock.patch.object(self.broker.files, 'open_ingress',
                mock.AsyncMock(return_value=({'artifactId': params['artifactId']}, fd))) as opened:
            try:
                with self.assertRaises(PermissionError):
                    await self.broker.open_artifact(WORKER_UID, params)
                self.assertEqual(await self.broker.open_artifact(INGRESS_UID, params),
                                 ({'artifactId': params['artifactId']}, fd))
                opened.assert_awaited_once_with(WORKER_UID, {**self.profile, 'role': 'user', 'generation': 0}, params['artifactId'])
            finally:
                os.close(fd)
            self.profile['status'] = 'blocked'
            with self.assertRaises(PermissionError):
                await self.broker.open_artifact(INGRESS_UID, params)

    async def test_open_artifact_closes_grant_if_profile_revoked_during_fetch(self):
        params = {'uid': WORKER_UID, 'artifactId': '6aad00bf-f419-4dda-a61c-7cab79c8c9b0'}
        fd = os.open(__file__, os.O_RDONLY)
        async def fetch(*args):
            self.profile['status'] = 'blocked'
            return {}, fd
        with mock.patch.object(self.broker.files, 'open_ingress', side_effect=fetch):
            with self.assertRaises(PermissionError):
                await self.broker.open_artifact(INGRESS_UID, params)
        with self.assertRaises(OSError):
            os.fstat(fd)

    async def test_open_artifact_closes_grant_if_input_changes_during_fetch(self):
        params = {'uid': WORKER_UID, 'artifactId': '6aad00bf-f419-4dda-a61c-7cab79c8c9b0',
                  'turnId': 'turn', 'inputId': 'a' * 64}
        turn = {'turnId': 'turn', 'inputId': 'a' * 64, 'telegramId': self.profile['telegramId']}
        self.broker.turns[WORKER_UID] = turn
        fd = os.open(__file__, os.O_RDONLY)
        async def fetch(*args):
            turn['inputId'] = 'b' * 64
            return {}, fd
        with mock.patch.object(self.broker.files, 'open_ingress', side_effect=fetch):
            with self.assertRaises(PermissionError):
                await self.broker.open_artifact(INGRESS_UID, params)
        with self.assertRaises(OSError):
            os.fstat(fd)

    async def test_proactive_artifact_fetch_is_ingress_only_and_owner_checked(self):
        artifact = '6aad00bf-f419-4dda-a61c-7cab79c8c9b0'
        with mock.patch.object(self.broker.files, 'fetch', mock.AsyncMock(
                return_value={'artifactId': artifact, 'localPath': '/verified/file'})) as fetch:
            with self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, 'ingress.delivery-artifact',
                                       {'uid': WORKER_UID, 'artifactId': artifact})
            self.assertEqual(await self.broker.call(INGRESS_UID, 'ingress.delivery-artifact',
                {'uid': WORKER_UID, 'artifactId': artifact}),
                {'artifactId': artifact, 'localPath': '/verified/file'})
            fetch.assert_awaited_once_with(WORKER_UID, {**self.profile, 'role': 'user', 'generation': 0},
                                           {'artifactId': artifact}, ingress=True)
            self.profile['status'] = 'blocked'
            with self.assertRaises(PermissionError):
                await self.broker.call(INGRESS_UID, 'ingress.delivery-artifact',
                                       {'uid': WORKER_UID, 'artifactId': artifact})
            self.assertEqual(fetch.await_count, 1)

    async def test_publish_rejects_nofollow_symlinks_hardlinks_and_foreign_owners(self):
        root, source, staging_uid, fake_lstat = self._publish_fixture()
        try:
            link = source.parent / "symlink.bin"
            link.symlink_to(source)
            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat):
                with self.assertRaises(OSError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(link), "requestId": "synthetic-symlink",
                    })
            self.assertFalse(any(call[0] == "artifacts.publish" for call in self.control.calls))

            hardlink = source.parent / "hardlink.bin"
            os.link(source, hardlink)
            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat):
                with self.assertRaises(PermissionError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(source), "requestId": "synthetic-hardlink",
                    })

            hardlink.unlink()
            real_open = os.open
            real_fstat = os.fstat
            opened_files = set()

            def track_open(path, flags, *args, **kwargs):
                fd = real_open(path, flags, *args, **kwargs)
                if path == source.name and kwargs.get("dir_fd") is not None:
                    opened_files.add(fd)
                return fd

            def foreign_fstat(fd):
                info = real_fstat(fd)
                if fd in opened_files:
                    return SimpleNamespace(
                        st_mode=info.st_mode, st_uid=WORKER_UID + 1,
                        st_nlink=info.st_nlink, st_size=info.st_size,
                    )
                return info

            with mock.patch.object(broker_module.Path, "lstat", autospec=True, side_effect=fake_lstat), \
                 mock.patch.object(broker_module.os, "open", side_effect=track_open), \
                 mock.patch.object(broker_module.os, "fstat", side_effect=foreign_fstat):
                with self.assertRaises(PermissionError):
                    await self.broker.publish(WORKER_UID, self.profile, {
                        "path": str(source), "requestId": "synthetic-foreign-owner",
                    })
            self.assertFalse(any(call[0] == "artifacts.publish" for call in self.control.calls))
        finally:
            shutil.rmtree(root)


    async def test_jsonrpc_batch_notifications_standard_errors_and_peer_uid(self):
        calls = []
        async def call(uid, method, params):
            calls.append((uid, method, params))
            return {'uid': uid}
        port = SimpleNamespace(call=call)
        response = await broker_module.rpc_frame(port, WORKER_UID, b'not JSON\n')
        self.assertEqual(response['error']['code'], -32700)
        response = await broker_module.rpc_frame(port, WORKER_UID, '{"jsonrpc":"2.0","id":NaN,"method":"tools.list"}')
        self.assertEqual(response['error']['code'], -32700)
        for request, code in [
                ({}, -32600),
                ({'jsonrpc': '2.0', 'id': True, 'method': 'tools.list'}, -32600),
                ({'jsonrpc': '2.0', 'id': 0, 'method': 'missing'}, -32601),
                ({'jsonrpc': '2.0', 'id': '', 'method': 'tools.list', 'params': []}, -32602),
                ({'jsonrpc': '2.0', 'id': 2, 'method': 'tools.list', 'params': {'uid': OTHER_UID}}, -32602)]:
            response = await broker_module.rpc_request(port, WORKER_UID, request)
            self.assertEqual(response['error']['code'], code)
        self.assertEqual(calls, [])
        batch = [
            {'jsonrpc': '2.0', 'id': 0, 'method': 'tools.list', 'params': {}},
            {'jsonrpc': '2.0', 'method': 'tools.list', 'params': {}},
            {'jsonrpc': '2.0', 'id': 'attack', 'method': 'tools.list', 'params': {'uid': OTHER_UID}},
            {'jsonrpc': '2.0', 'id': None, 'method': 'missing'}]
        import json
        response = await broker_module.rpc_frame(port, WORKER_UID, json.dumps(batch))
        self.assertEqual([item['id'] for item in response], [0, 'attack', None])
        self.assertEqual(response[0]['result'], {'uid': WORKER_UID})
        self.assertEqual(response[1]['error']['code'], -32602)
        self.assertEqual(response[2]['error']['code'], -32601)
        self.assertEqual([item[0] for item in calls], [WORKER_UID, WORKER_UID])
        response = await broker_module.rpc_frame(port, WORKER_UID, json.dumps(batch * 5))
        self.assertEqual(response['error']['code'], -32600)
        response = await broker_module.rpc_frame(port, WORKER_UID, '[]')
        self.assertEqual(response['error']['code'], -32600)
        notification = await broker_module.rpc_request(port, WORKER_UID,
            {'jsonrpc': '2.0', 'method': 'tools.list'})
        self.assertIsNone(notification)

    async def test_repeated_ingress_admit_preserves_suppression_and_request_id(self):
        params = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True, 'turnId': 'same'}
        await self.broker.call(INGRESS_UID, 'ingress.admit', params)
        await self.broker.call(WORKER_UID, 'login.send', {})
        previous = dict(self.broker.turns[WORKER_UID])
        await self.broker.call(INGRESS_UID, 'ingress.admit', params)
        self.assertEqual(self.broker.turns[WORKER_UID], previous)
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.admit', {**params, 'turnId': 'competing'})
        self.assertEqual(self.broker.turns[WORKER_UID], previous)




    async def admit_login_input(self, input_id='a' * 64):
        """Зарегистрировать реальный private input без параметров из модели."""
        return await self.broker.call(INGRESS_UID, 'ingress.admit', {
            'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
            'turnId': 'login-turn', 'inputId': input_id})

    async def test_login_parallel_duplicate_and_replay_send_only_once(self):
        await self.admit_login_input()
        started, release, sends = asyncio.Event(), asyncio.Event(), []
        original = self.control.call
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            self.assertEqual(self.broker.delivery_state().lookup(params['requestId']), 'unknown')
            started.set()
            await release.wait()
            return {'status': 'sent', 'code': 'must-not-be-cached'}
        self.control.call = call
        first = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.wait_for(started.wait(), 1)
        second = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(first, second)
        self.assertEqual(results, [{'status': 'sent', 'suppressFinal': True}] * 2)
        self.assertEqual(len(sends), 1)
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), results[0])
        self.assertEqual(len(sends), 1)
        self.assertEqual(self.broker.login_state.db.execute(
            'SELECT request_id,outcome FROM login_receipts').fetchall(),
            [(sends[0]['requestId'], 'sent')])

    async def test_new_actual_input_uses_fresh_login_request_and_clears_suppression(self):
        await self.admit_login_input('a' * 64)
        first_id = self.broker.turns[WORKER_UID]['requestId']
        await self.broker.call(WORKER_UID, 'login.send', {})
        await self.admit_login_input('a' * 64)
        self.assertEqual(self.broker.turns[WORKER_UID]['requestId'], first_id)
        self.assertTrue(self.broker.turns[WORKER_UID]['suppressFinal'])
        await self.admit_login_input('b' * 64)
        second_id = self.broker.turns[WORKER_UID]['requestId']
        self.assertNotEqual(second_id, first_id)
        self.assertIsNone(self.broker.turns[WORKER_UID]['loginRecord']['outcome'])
        self.assertFalse(self.broker.turns[WORKER_UID]['suppressFinal'])
        await self.broker.call(WORKER_UID, 'login.send', {})
        issued = [params['requestId'] for method, params, _ in self.control.calls if method == 'login.send']
        self.assertEqual(issued, [first_id, second_id])

    async def test_login_uses_admitted_topic_and_rejects_worker_topic_override(self):
        admission = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                     'turnId': 'topic-turn', 'inputId': 'a' * 64, 'threadId': 73}
        broker_module.validate_params('ingress.admit', admission)
        await self.broker.call(INGRESS_UID, 'ingress.admit', admission)
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'login.send', {'threadId': 99})
        with self.assertRaises(PermissionError):
            await self.broker.call(INGRESS_UID, 'ingress.admit', {**admission, 'threadId': 99})
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}),
                         {'status': 'sent', 'suppressFinal': True})
        sends = [params for method, params, _ in self.control.calls if method == 'login.send']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]['threadId'], 73)
        # Смена темы после закрытия хода не разрешает повтор прежнего input.
        await self.broker.call(INGRESS_UID, 'ingress.close', {'uid': WORKER_UID, 'turnId': 'topic-turn'})
        await self.broker.call(INGRESS_UID, 'ingress.admit', {**admission, 'turnId': 'next-turn', 'threadId': 99})
        await self.broker.call(WORKER_UID, 'login.send', {})
        self.assertEqual(len([c for c in self.control.calls if c[0] == 'login.send']), 1)
        for invalid in (0, -1, True, '73', None, 1.5, 9007199254740992):
            with self.subTest(threadId=invalid), self.assertRaises(ValueError):
                broker_module.validate_params('ingress.admit', {**admission, 'threadId': invalid})

    async def test_failed_unknown_exception_and_cancellation_are_not_automatically_replayed(self):
        original = self.control.call
        sends = []
        for index, outcome in enumerate(('failed', 'unknown', 'raise', 'cancel')):
            await self.admit_login_input(format(index, '064x'))
            started = asyncio.Event()
            async def call(method, params, timeout=35):
                if method != 'login.send':
                    return await original(method, params, timeout)
                sends.append(dict(params))
                started.set()
                if outcome == 'raise':
                    raise ConnectionError('synthetic lost response')
                if outcome == 'cancel':
                    await asyncio.Event().wait()
                return {'status': 'failed' if outcome == 'failed' else 'unknown'}
            self.control.call = call
            expected = {'status': 'failed' if outcome == 'failed' else 'unknown', 'suppressFinal': False}
            if outcome == 'cancel':
                sending = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
                await asyncio.wait_for(started.wait(), 1)
                sending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await sending
            else:
                self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), expected)
            self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}), expected)
            self.assertEqual(len(sends), index + 1)

    async def test_late_old_login_completion_does_not_suppress_new_input(self):
        await self.admit_login_input('a' * 64)
        old_id = self.broker.turns[WORKER_UID]['requestId']
        started, release, sends = asyncio.Event(), asyncio.Event(), []
        original = self.control.call
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            started.set()
            await release.wait()
            return {'status': 'sent'}
        self.control.call = call
        old = asyncio.create_task(self.broker.call(WORKER_UID, 'login.send', {}))
        await asyncio.wait_for(started.wait(), 1)
        await self.admit_login_input('b' * 64)
        new_turn = self.broker.turns[WORKER_UID]
        self.assertNotEqual(new_turn['requestId'], old_id)
        release.set()
        self.assertEqual(await old, {'status': 'sent', 'suppressFinal': False})
        self.assertIs(self.broker.turns[WORKER_UID], new_turn)
        self.assertFalse(new_turn['suppressFinal'])
        self.assertIsNone(new_turn['loginRecord']['outcome'])
        self.assertEqual(self.broker.login_state.lookup(old_id), 'sent')
        self.assertEqual(await self.broker.call(WORKER_UID, 'login.send', {}),
                         {'status': 'sent', 'suppressFinal': True})
        self.assertEqual(len(sends), 2)

    async def test_persistent_receipt_precedes_network_and_survives_restart(self):
        root = Path(tempfile.mkdtemp(prefix='broker-login-state-', dir=TEMP_ROOT))
        state_path = root / 'delivery.sqlite'
        state_path.touch(mode=0o600)
        self.config['loginDeliveryStatePath'] = str(state_path)
        original = self.control.call
        sends = []
        async def call(method, params, timeout=35):
            if method != 'login.send':
                return await original(method, params, timeout)
            sends.append(dict(params))
            with broker_module.sqlite3.connect(state_path) as observer:
                self.assertEqual(observer.execute(
                    'SELECT outcome FROM login_receipts WHERE request_id=?',
                    (params['requestId'],)).fetchone(), ('unknown',))
            return {'status': 'sent', 'code': 'never-save-this-code'}
        self.control.call = call
        # Только проверка root metadata заменена: реальные SQLite commit/reopen не подменяются.
        with mock.patch.object(broker_module, '_secure_login_state_path', return_value=str(state_path)):
            disk_state = broker_module.LoginDeliveryState(str(state_path))
            self.broker.login_state = disk_state
            try:
                await self.admit_login_input('a' * 64)
                first_id = self.broker.turns[WORKER_UID]['requestId']
                await self.broker.call(WORKER_UID, 'login.send', {})
                await self.broker.call(INGRESS_UID, 'ingress.close', {'uid': WORKER_UID, 'turnId': 'login-turn'})
                disk_state.close()
                restarted = Broker(self.config, self.control)
                restarted.profiles = self.broker.profiles
                try:
                    await restarted.call(INGRESS_UID, 'ingress.admit', {
                        'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                        'turnId': 'after-restart', 'inputId': 'a' * 64, 'messageId': '101'})
                    self.assertEqual(restarted.turns[WORKER_UID]['requestId'], first_id)
                    self.assertEqual(await restarted.call(WORKER_UID, 'login.send', {}),
                                     {'status': 'sent', 'suppressFinal': True})
                    self.assertEqual(len(sends), 1)
                    columns = restarted.login_state.db.execute('PRAGMA table_info(login_receipts)').fetchall()
                    self.assertEqual([row[1] for row in columns], ['request_id', 'outcome'])
                    self.assertNotIn(b'never-save-this-code', state_path.read_bytes())
                    self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)
                    self.assertEqual(restarted.login_state.db.execute('PRAGMA synchronous').fetchone(), (2,))
                finally:
                    if restarted.login_state is not None:
                        restarted.login_state.close()
            finally:
                # connection уже закрыт перед настоящим reopen.
                disk_state.close()
                shutil.rmtree(root)


    async def test_unknown_receipt_survives_crash_and_cannot_be_replayed(self):
        root = Path(tempfile.mkdtemp(prefix='broker-login-unknown-', dir=TEMP_ROOT))
        state_path = root / 'delivery.sqlite'
        state_path.touch(mode=0o600)
        self.config['loginDeliveryStatePath'] = str(state_path)
        request_id = broker_module.login_request_id(WORKER_UID, self.profile, '111222', 'a' * 64)
        with mock.patch.object(broker_module, '_secure_login_state_path', return_value=str(state_path)):
            before_crash = broker_module.LoginDeliveryState(str(state_path))
            self.assertEqual(before_crash.claim(request_id), (True, 'unknown'))
            before_crash.close()
            restarted = Broker(self.config, self.control)
            restarted.profiles = self.broker.profiles
            try:
                await restarted.call(INGRESS_UID, 'ingress.admit', {
                    'telegramId': '111222', 'chatId': '111222', 'privateChat': True,
                    'turnId': 'restart-turn', 'inputId': 'a' * 64, 'messageId': '101'})
                self.assertEqual(await restarted.call(WORKER_UID, 'login.send', {}),
                                 {'status': 'unknown', 'suppressFinal': False})
                self.assertFalse(any(method == 'login.send' for method, params, timeout in self.control.calls))
            finally:
                if restarted.login_state is not None:
                    restarted.login_state.close()
                shutil.rmtree(root)

    async def test_delivery_capacity_keeps_existing_receipts_and_ordinary_admission(self):
        state = broker_module.LoginDeliveryState(':memory:', max_records=1)
        self.addCleanup(state.close)
        self.broker.login_state = state
        await self.admit_login_input('a' * 64)
        await self.broker.call(WORKER_UID, 'login.send', {})
        await self.admit_login_input('b' * 64)
        self.assertFalse(self.broker.turns[WORKER_UID]['suppressFinal'])
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'login.send', {})
        self.assertEqual(len([call for call in self.control.calls if call[0] == 'login.send']), 1)
        self.assertEqual(state.db.execute('SELECT count(*) FROM login_receipts').fetchone()[0], 1)

    def test_trusted_input_identity_schema_and_private_state_path(self):
        params = {'telegramId': '111222', 'chatId': '111222', 'privateChat': True, 'turnId': 't'}
        broker_module.validate_params('ingress.admit', params)
        broker_module.validate_params('ingress.admit', {**params, 'inputId': 'a' * 64, 'messageId': '101'})
        for invalid in ('', 'a' * 63, 'z' * 64, 1, None):
            with self.subTest(inputId=invalid), self.assertRaises(ValueError):
                broker_module.validate_params('ingress.admit', {**params, 'inputId': invalid})
        with self.assertRaises(PermissionError):
            broker_module._secure_login_state_path(str(TEMP_ROOT / 'unsafe-delivery.sqlite'))

    async def test_provisioning_can_discover_catalog_but_cannot_dispatch_or_read_data(self):
        self.profile['status'] = 'provisioning'
        home = self.profile['home']
        entry = {'userId': self.profile['userId'], 'profileId': self.profile['profileId'], 'home': home,
                 'cacheRoot': '/protected/cache', 'stagingRoot': '/protected/staging/' + str(WORKER_UID)}
        self.broker.files.config['runtimeProfilesPath'] = '/protected/runtime-profiles.json'
        self.broker.files.config_reader = lambda path: {str(WORKER_UID): entry}
        expected = {'ownerId': self.profile['userId'], 'stateRoot': home + '/workspace/files',
                    'resultRoot': home + '/results', 'readRoots': [home + '/workspace', home + '/media', home + '/results']}
        async def configuration(method, params, **kwargs):
            self.assertEqual(method, 'files.configuration')
            self.assertEqual(params, {'uid': WORKER_UID})
            return expected
        self.broker.files.control = SimpleNamespace(call=configuration)
        result = await self.broker.call(WORKER_UID, 'files.configuration', {})
        self.assertEqual(result, expected)
        for method, params in [
                ('files.get', {'artifactId': 'a'}), ('files.list', {}),
                ('files.prepare', {'mode': 'files', 'items': []}),
                ('files.fetch', {'artifactId': 'a'}),
                ('files.publish', {'path': home + '/workspace/file', 'requestId': 'request'}),
                ('tools.call', {'name': 'any', 'args': {}}),
                ('login.send', {}), ('memory.search', {}),
                ('files.configuration', {'uid': OTHER_UID})]:
            with self.subTest(method=method), self.assertRaises(PermissionError):
                await self.broker.call(WORKER_UID, method, params)
        self.assertEqual(self.control.calls, [])
        await self.broker.call(WORKER_UID, 'tools.list', {})
        self.assertEqual(self.control.calls, [('tools.list', {'uid': WORKER_UID}, 35)])
        with self.assertRaises(PermissionError):
            await self.broker.call(OTHER_UID, 'files.configuration', {})
        entry['userId'] = 'foreign-user'
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'files.configuration', {})
        entry['userId'] = self.profile['userId']
        self.profile['status'] = 'blocked'
        with self.assertRaises(PermissionError):
            await self.broker.call(WORKER_UID, 'files.configuration', {})

    async def test_large_unicode_crosses_real_private_control_without_ascii_expansion(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        source = (Path(__file__).resolve().parents[1] / 'control.mjs').as_uri()
        program = ("import {servePrivateRpc} from " + json.dumps(source) + ";"
            "const control={invokeTool:async(uid,name,args)=>({bytes:Buffer.byteLength(args.text)})};"
            "await servePrivateRpc({control},process.stdin,process.stdout);")
        port = broker_module.ControlPort([node, '--input-type=module', '-e', program], '/unused')
        await port.start()
        try:
            for text in ('a' * 400000, 'я' * 400000, '🧠' * 200000):
                result = await port.call('tools.call', {'uid': WORKER_UID,
                    'name': 'dialogues_exchange', 'args': {'text': text}})
                self.assertEqual(result, {'bytes': len(text.encode())})
        finally:
            await port.close()

    async def test_control_reserves_authorization_capacity_when_tool_calls_are_full(self):
        control = broker_module.ControlPort([], '/unused')
        class Input:
            def write(self, _payload):
                pass
            async def drain(self):
                pass
        control.process = SimpleNamespace(returncode=None, stdin=Input())
        tools = [asyncio.create_task(control.call('tools.call', {'uid': i})) for i in range(32)]
        await asyncio.sleep(0)
        try:
            self.assertEqual(len(control.pending), 32)
            with self.assertRaises(ConnectionError):
                await control.call('tools.call', {})
            authorization = asyncio.create_task(control.call('authorize', {'uid': WORKER_UID}))
            await asyncio.sleep(0)
            self.assertEqual(len(control.pending), 33)
            control.pending[control.counter].set_result({'allowed': True})
            self.assertEqual(await authorization, {'allowed': True})
            self.assertEqual(control.pending_budgets[True], 0)
        finally:
            for task in tools:
                task.cancel()
            await asyncio.gather(*tools, return_exceptions=True)
        self.assertEqual(control.pending_budgets, {False: 0, True: 0})

    async def test_late_control_response_does_not_break_current_request(self):
        control = broker_module.ControlPort([], '/unused')
        reader = asyncio.StreamReader()
        control.process = SimpleNamespace(stdout=reader)
        control.counter = 2
        current = asyncio.get_running_loop().create_future()
        control.pending[2] = current
        reader.feed_data(b'{"jsonrpc":"2.0","id":1,"result":{"late":true}}\n')
        reader.feed_data(b'{"jsonrpc":"2.0","id":2,"result":{"current":true}}\n')
        reader.feed_eof()
        await control.read()
        self.assertEqual(current.result(), {'current': True})

    async def test_actual_unix_listener_accepts_notifications_without_response(self):
        socket_path = TEMP_ROOT / ("broker-" + str(os.getpid()) + ".sock")
        config = {
            "controlCommand": [sys.executable, "-c", "import time; time.sleep(60)"],
            "controlConfigPath": "synthetic-control-config",
            "socketPath": str(socket_path),
            "ingressUid": WORKER_UID,
            "stagingRoot": self.config["stagingRoot"],
            "registryPath": "unused-registry",
        }
        serving = asyncio.create_task(broker_module.serve(config))
        try:
            deadline = asyncio.get_running_loop().time() + 5
            while not socket_path.exists() and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.01)
            self.assertTrue(socket_path.exists(), "broker AF_UNIX listener did not start")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(5)
                client.connect(str(socket_path))
                client.sendall(b'{"jsonrpc":"2.0","method":"tools.list","params":{}}\n')
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(await asyncio.to_thread(client.recv, 1024), b"", "notifications must receive no broker result")

            async def exchange(raw):
                reader, writer = await asyncio.open_unix_connection(str(socket_path))
                try:
                    writer.write(raw)
                    await writer.drain()
                    return await reader.read()
                finally:
                    writer.close()
                    await writer.wait_closed()
            import json
            for raw, expected in [
                    (b'{bad json\n', -32700),
                    (b'{}\n', -32600),
                    (b'{"jsonrpc":"2.0","id":0,"method":"unknown"}\n', -32601),
                    (b'{"jsonrpc":"2.0","id":"invalid","method":"tools.list","params":{"uid":1}}\n', -32602)]:
                response = json.loads(await exchange(raw))
                self.assertEqual(response['error']['code'], expected)
            response = json.loads(await exchange(b'[{"jsonrpc":"2.0","id":1,"method":"unknown"},{"jsonrpc":"2.0","method":"unknown"}]\n'))
            self.assertEqual(len(response), 1)
            self.assertEqual(response[0]['id'], 1)
        finally:
            serving.cancel()
            with suppress(asyncio.CancelledError):
                await serving


if __name__ == "__main__":
    unittest.main()
