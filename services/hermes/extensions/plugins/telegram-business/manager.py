"""Telegram Business Mode (Secretary Bots) — owner-approved drafting.

When a Telegram Business account owner connects this bot via BotFather's
Business Mode, the bot starts receiving messages addressed to the owner
in chats the owner has whitelisted. This module turns those incoming
customer messages into drafted replies that the owner approves before
they go out — no auto-send, ever.

User flow (the simplest path that works end-to-end):

  1. Owner enables Business Mode in BotFather and connects this bot.
     → bot receives ``BusinessConnection`` update, persists it, DMs the
     owner an onboarding message with a quick how-it-works summary.

  2. Customer messages the owner in a chat covered by the connection.
     → bot debounces ``debounce_seconds`` (default 8s) to coalesce
     typing bursts, then drafts a single reply using the most-recent
     customer text.
     → bot DMs the draft to the *owner's* chat with this bot, with
     inline buttons: [✓ Send]  [✎ Edit]  [✕ Discard].

  3. Owner taps:
       Send    → bot sends the draft to the customer chat using
                 ``business_connection_id``. Owner gets a "✓ Sent" confirmation.
       Edit    → bot replies "send me the text you want delivered" and
                 captures the owner's next text DM as the outgoing reply.
       Discard → draft dropped, nothing goes to the customer.

The owner is always in control: ``can_reply`` from Telegram is required
for the Send button to appear, ``/biz pause`` globally suspends drafting,
and per-chat pauses live in ``telegram_business_connections.paused_chats``.

State lives in two SQLite tables in the plugin's own database file
(``<HERMES_HOME>/telegram-business/state.db``) — see ``state.py`` for the
schema. Hermes' core state.db is never touched.

This module is glued onto the Hermes Telegram adapter by ``__init__.py``
via ``ctx.register_telegram_handler`` — the adapter invokes the plugin's
factory at connect() time and the factory wires PTB update handlers plus
an inline-button callback prefix (``bd:`` for "business draft"). The host
adapter owns all Telegram I/O — this module just calls back into it for
sending.
"""

from __future__ import annotations

from hermes_cli.ui_localization import translate_ui as _ui

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# Callback-data prefix for the inline buttons. Keep it short — Telegram
# caps callback_data at 64 bytes.  Format: "bd:<choice>:<draft_id>".
CALLBACK_PREFIX = "bd:"


# Choice values rendered on the inline keyboard.
CHOICE_SEND = "send"
CHOICE_EDIT = "edit"
CHOICE_DISCARD = "discard"


# Onboarding text the bot DMs the owner the first time a BusinessConnection
# arrives. Plain text (Telegram MarkdownV2 escaping is fragile, and this
# message is content-stable enough to hand-author).
ONBOARDING_MESSAGE = (
    _ui("🤝 You've connected me as your Telegram Business assistant.\n\n"
    "Here's how it works:\n"
    "• When someone messages you in a chat I have access to, I'll draft "
    "a reply and send it to you here.\n"
    "• You'll see [✓ Send] [✎ Edit] [✕ Discard] buttons. Nothing goes "
    "to your contact until you tap Send.\n"
    "• Tap Edit to override the draft with your own wording.\n"
    "• Tap Discard to drop the draft entirely.\n\n"
    "Useful commands:\n"
    "  /biz             — show status and active connections\n"
    "  /biz pause       — pause drafting (you still see the messages)\n"
    "  /biz resume      — resume drafting\n"
    "  /biz off         — disable drafting for one chat (reply to that customer's draft)\n\n"
    "I never auto-send. Every reply is yours to approve.")
)


# ---------------------------------------------------------------------------
# Type aliases for the adapter callbacks the manager depends on.
# Defined as Callables so this module stays import-light and decoupled
# from the rest of the telegram.py module.
# ---------------------------------------------------------------------------

# Generates a draft reply text for a given customer message.
# Returns the draft text, or raises on failure.
DraftGenerator = Callable[[str, Any], Awaitable[str]]

# Sends a message to a chat. For owner DMs, business_connection_id is None.
# For customer chats reached via business mode, business_connection_id is set.
SendMessage = Callable[..., Awaitable[Any]]  # delegates to bot.send_message kwargs


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class BusinessModeManager:
    """Owns Business Mode state and orchestrates drafting + approval.

    One instance per Telegram adapter. The adapter wires up handlers in
    ``connect()`` and calls into this manager for every business update.
    """

    def __init__(
        self,
        *,
        session_db: Any,
        send_message: SendMessage,
        draft_generator: DraftGenerator,
        debounce_seconds: float = 8.0,
        draft_ttl_hours: float = 24.0,
        max_customer_text_chars: int = 4000,
        contextual_drafting: bool = False,
        archive_context: Any = None,
    ) -> None:
        self._db = session_db
        self._send = send_message
        self._draft_generator = draft_generator
        self._contextual_drafting = contextual_drafting
        self._archive_context = archive_context
        self._debounce_seconds = max(0.0, float(debounce_seconds))
        self._draft_ttl_seconds = max(60.0, float(draft_ttl_hours) * 3600.0)
        self._max_customer_text_chars = int(max_customer_text_chars)

        # In-flight debounce tasks, keyed by (connection_id, customer_chat_id).
        # New customer messages reset the timer so a typing burst yields one draft.
        self._debounce_tasks: Dict[str, asyncio.Task] = {}
        self._debounce_buffers: Dict[str, Dict[str, Any]] = {}

        # Owner DMs that are in "next message = edited reply" mode.
        # Keyed by owner_chat_id → draft_id awaiting the override text.
        self._edit_capture: Dict[str, int] = {}

    # ------------------------------------------------------------------
    # BusinessConnection updates (established / edited / ended).
    # ------------------------------------------------------------------

    async def handle_connection_update(self, business_connection: Any) -> None:
        """Persist or remove a connection row.

        ``business_connection`` is a PTB ``BusinessConnection`` object.
        On Telegram Bot API 9.0+, ``rights`` is an object with ``can_reply``
        among other flags; on older versions a ``can_reply`` bool sits on
        the connection itself.  We tolerate both shapes.
        """
        conn_id = getattr(business_connection, "id", None)
        user = getattr(business_connection, "user", None)
        owner_user_id = getattr(user, "id", None)
        owner_chat_id = getattr(business_connection, "user_chat_id", None)
        is_enabled = bool(getattr(business_connection, "is_enabled", False))
        if conn_id is None or owner_user_id is None or owner_chat_id is None:
            logger.warning(
                "BusinessConnection update missing required fields: id=%s, user.id=%s, user_chat_id=%s",
                conn_id, owner_user_id, owner_chat_id,
            )
            return

        # ``can_reply`` location moved in API 9.0 from connection root to
        # ``rights.can_reply``.  Probe rights first.
        can_reply = False
        rights = getattr(business_connection, "rights", None)
        if rights is not None:
            can_reply = bool(getattr(rights, "can_reply", False))
        else:
            can_reply = bool(getattr(business_connection, "can_reply", False))

        previous = self._db.get_telegram_business_connection(str(conn_id))
        self._db.upsert_telegram_business_connection(
            connection_id=str(conn_id),
            owner_user_id=str(owner_user_id),
            owner_chat_id=str(owner_chat_id),
            can_reply=can_reply,
            is_enabled=is_enabled,
        )

        # First-time onboarding DM.
        if previous is None and is_enabled:
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=ONBOARDING_MESSAGE,
                    disable_notification=False,
                )
            except Exception as exc:
                logger.warning("Failed to deliver business-mode onboarding DM")

        # Connection ended → DM the owner a confirmation.
        if previous is not None and previous.get("is_enabled") and not is_enabled:
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=_ui("🔌 Business connection ended. I won't draft any more replies."),
                    disable_notification=True,
                )
            except Exception as exc:
                logger.debug("Disconnection notice send failed")

        # can_reply changed → tell the owner.
        if previous is not None and previous.get("is_enabled") and is_enabled:
            if previous.get("can_reply") != can_reply:
                msg = (
                    _ui("✅ Send-on-your-behalf permission enabled — Send buttons are now live.")
                    if can_reply else
                    _ui("⚠️ Send-on-your-behalf permission is OFF in your Telegram Business "
                    "settings. I'll still draft replies but you'll need to copy and "
                    "send them yourself.")
                )
                try:
                    await self._send(
                        chat_id=int(owner_chat_id), text=msg, disable_notification=True,
                    )
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # business_message updates (customer talks to owner).
    # ------------------------------------------------------------------

    async def handle_business_message(self, message: Any, *, edited: bool = False) -> None:
        """Schedule a debounced draft for an incoming customer message.

        ``message`` is a PTB ``Message`` from a business_message update.
        It has ``business_connection_id``, ``chat`` (the customer chat),
        ``from_user`` (the customer), and ``text``/``caption``.
        """
        conn_id = getattr(message, "business_connection_id", None)
        if not conn_id:
            return

        conn = self._db.get_telegram_business_connection(str(conn_id))
        if not conn:
            logger.debug("Received business_message for unknown connection %s", conn_id)
            return
        if not conn.get("is_enabled"):
            return

        chat = getattr(message, "chat", None)
        customer_chat_id = getattr(chat, "id", None)
        if customer_chat_id is None:
            return
        # Pull text. Captions on media count too — they're often the only
        # part the customer typed.
        text = (getattr(message, "text", None) or getattr(message, "caption", None) or "").strip()
        if not text:
            # Pure media without caption — out of scope for v1 (no vision pipeline).
            return
        if len(text) > self._max_customer_text_chars:
            text = text[: self._max_customer_text_chars]

        scope = self._db.business_scope(str(conn_id), str(customer_chat_id))
        author_id = str(getattr(getattr(message, 'from_user', None), 'id', '') or '')
        if not author_id or getattr(chat, 'type', 'private') != 'private':
            return
        # A private incoming author must be this scope's owner or recipient.
        # In particular, a late echo from a previous owner is not a customer.
        if author_id not in (scope['owner'], scope['recipient']):
            return
        actor = 'owner' if author_id == scope['owner'] else 'customer'
        if getattr(message, 'sender_business_bot', None) is not None:
            # A bot origin is never customer input. Trust only an existing
            # outgoing identity or one unambiguous durable in-flight claim;
            # neither message text nor the current connection proves ownership.
            if actor != 'owner' or not self._verified_business_echo(
                    scope, str(getattr(message, 'message_id', '') or '')):
                return
            actor = 'approved_ai'
        stamp = getattr(message,'edit_date',None) or getattr(message,'date',None)
        event_at = stamp.timestamp() if stamp is not None and hasattr(stamp,'timestamp') else None
        if not self._db.record_business_message(scope, str(getattr(message, 'message_id', '')), text,
                actor=actor, author_id=author_id,
                origin='telegram_bot_echo' if actor == 'approved_ai' else ('telegram_edited' if edited else ('telegram_owner' if actor == 'owner' else 'telegram_incoming')),
                event_at=event_at):
            return
        from agent.memory_manager import _redact_for_provider
        text = _redact_for_provider(text)
        if self._archive_context:
            await asyncio.to_thread(self._archive_context.archive_pending)
        if actor != 'customer' or not conn.get('auto_draft', True) or str(customer_chat_id) in (conn.get('paused_chats') or []):
            return

        key = f"{conn_id}:{customer_chat_id}"

        # Cancel any in-flight debounce for this (connection, customer chat) so
        # rapid bursts coalesce into a single draft against the latest text.
        prior = self._debounce_tasks.pop(key, None)
        if prior is not None and not prior.done():
            prior.cancel()

        # Buffer the latest message info — the timer will read this at fire time.
        self._debounce_buffers[key] = {
            "scope": scope,
            "version": self._db.business_version(scope),
            "conn_id": str(conn_id),
            "owner_chat_id": str(conn.get("owner_chat_id")),
            "customer_chat_id": str(customer_chat_id),
            "customer_msg_id": str(getattr(message, "message_id", "") or ""),
            "customer_text": text,
            "customer_name": _customer_display_name(message),
        }

        # Schedule the actual draft.  If debounce is zero (test mode), fire
        # immediately so the test doesn't have to wait.
        if self._debounce_seconds <= 0:
            await self._run_draft(key)
        else:
            self._debounce_tasks[key] = asyncio.create_task(
                self._debounce_then_draft(key)
            )

    def _verified_business_echo(self, scope, message_id):
        if not message_id:
            return False
        with self._db._lock:
            prior = self._db._conn.execute('''SELECT author_id,actor,origin,deleted
                FROM business_messages WHERE scope_id=? AND message_id=?''',
                (self._db._digest(scope), message_id)).fetchone()
            if prior is not None:
                return bool(not prior['deleted'] and prior['author_id'] == scope['owner']
                    and prior['actor'] in ('owner', 'approved_ai')
                    and prior['origin'] in ('approved_send', 'owner_edit_send', 'telegram_bot_echo'))
            claims = self._db._conn.execute('''SELECT scope FROM business_drafts
                WHERE connection_id=? AND customer_chat_id=? AND status='sending'
                AND send_token IS NOT NULL AND send_action IN ('send','edit_send')''',
                (scope['connection'], scope['chat'])).fetchall()
        # Before acknowledgement the Telegram message ID is not known yet.
        # Ambiguous or historical claims must not adopt the current owner's scope.
        if len(claims) != 1:
            return False
        try:
            return json.loads(claims[0]['scope']) == scope
        except (ValueError, TypeError):
            return False

    async def _debounce_then_draft(self, key: str) -> None:
        try:
            await asyncio.sleep(self._debounce_seconds)
        except asyncio.CancelledError:
            return
        try:
            await self._run_draft(key)
        finally:
            self._debounce_tasks.pop(key, None)

    async def _run_draft(self, key: str) -> None:
        buf = self._debounce_buffers.pop(key, None)
        if not buf:
            return

        # Re-check the connection state — owner may have hit /biz pause
        # during the debounce window.
        conn = self._db.get_telegram_business_connection(buf["conn_id"])
        if not conn or not conn.get("is_enabled") or not conn.get("auto_draft", True):
            return
        if buf["customer_chat_id"] in (conn.get("paused_chats") or []):
            return

        try:
            draft_text = await self._draft_generator(
                buf["customer_text"], buf["scope"] if self._contextual_drafting else buf["customer_chat_id"]
            )
        except Exception as exc:
            logger.warning("Business-mode draft generator failed stage=draft_generation exception=%s", type(exc).__name__)
            try:
                await self._send(
                    chat_id=int(buf["owner_chat_id"]),
                    text="⚠️ Не удалось подготовить ответ. Проверьте переписку в Telegram.",
                    disable_notification=True,
                )
            except Exception:
                pass
            return

        draft_text = (draft_text or "").strip()
        current = self._db.get_telegram_business_connection(buf['conn_id'])
        if not current or not current['is_enabled'] or not current['auto_draft'] or buf['customer_chat_id'] in current['paused_chats']:
            return
        try:
            if self._db.business_version(buf['scope']) != buf['version']:
                return
        except ValueError:
            return
        if not draft_text:
            logger.debug("Empty draft for %s — skipping", key)
            return

        draft_id = self._db.create_telegram_business_draft(
            connection_id=buf["conn_id"],
            owner_chat_id=buf["owner_chat_id"],
            customer_chat_id=buf["customer_chat_id"],
            customer_msg_id=buf["customer_msg_id"] or None,
            customer_text=buf["customer_text"],
            draft_text=draft_text,
            ttl_seconds=self._draft_ttl_seconds,
            expected_version=buf['version'],
        )
        if not draft_id:
            return

        owner_message = self._render_draft_owner_message(
            customer_name=buf["customer_name"],
            customer_text=buf["customer_text"],
            draft_text=draft_text,
        )
        keyboard = self._build_draft_keyboard(draft_id, can_reply=bool(conn.get("can_reply")))

        try:
            sent = await self._send(
                chat_id=int(buf["owner_chat_id"]),
                text=owner_message,
                reply_markup=keyboard,
                disable_notification=False,
            )
        except Exception as exc:
            logger.warning("Failed to deliver business-mode draft to owner exception=%s", type(exc).__name__)
            # Mark the draft expired so we don't leave an unactionable row.
            self._db.resolve_telegram_business_draft(draft_id, status="expired")
            return

        owner_msg_id = getattr(sent, "message_id", None)
        if owner_msg_id is not None:
            self._db.set_telegram_business_draft_owner_message(draft_id, str(owner_msg_id))

    # ------------------------------------------------------------------
    # Inline-button callback dispatch (bd:choice:draft_id)
    # ------------------------------------------------------------------

    async def handle_callback(
        self,
        *,
        data: str,
        caller_user_id: Optional[str],
        answer: Callable[..., Awaitable[Any]],
        edit_message_text: Callable[..., Awaitable[Any]],
    ) -> bool:
        """Handle a callback_query whose data starts with ``bd:``.

        Returns True if the callback was dispatched (caller should stop
        further handling), False if it wasn't ours.
        """
        if not data.startswith(CALLBACK_PREFIX):
            return False

        parts = data.split(":", 2)
        if len(parts) != 3:
            await answer(text=_ui("Invalid draft action."))
            return True
        choice = parts[1]
        try:
            draft_id = int(parts[2])
        except ValueError:
            await answer(text=_ui("Invalid draft action."))
            return True

        draft = self._db.get_telegram_business_draft(draft_id)
        if draft is None:
            await answer(text=_ui("That draft has expired."))
            return True
        if draft.get("status") != "pending":
            await answer(text=_ui("That draft has already been resolved."))
            return True

        # Only the owner of this connection may act on the buttons.
        conn = self._db.get_telegram_business_connection(draft["connection_id"])
        if not conn:
            await answer(text=_ui("Connection no longer exists."))
            return True
        if not caller_user_id or str(caller_user_id) != str(conn.get("owner_user_id")):
            await answer(text=_ui("⛔ Only the connected account owner can use these buttons."))
            return True
        try:
            self._db._validate_scope(json.loads(draft.get('scope') or 'null'))
            if draft['owner_chat_id'] != conn['owner_chat_id'] or draft['expires_at'] <= time.time():
                raise ValueError('Stale business draft')
        except (ValueError, TypeError):
            await answer(text=_ui('That draft is no longer actionable.'))
            return True

        if choice == CHOICE_DISCARD:
            resolved = self._db.resolve_telegram_business_draft(draft_id, status="discarded", caller_user_id=caller_user_id)
            if not resolved:
                await answer(text=_ui('That draft is no longer actionable.'))
                return True
            await answer(text=_ui("✕ Discarded"))
            try:
                await edit_message_text(
                    text=self._render_resolved_message(draft, status="discarded"),
                    reply_markup=None,
                )
            except Exception:
                pass
            return True

        if choice == CHOICE_EDIT:
            if not self._db.claim_business_draft(draft_id,caller_user_id,action='edit'):
                await answer(text=_ui('That draft is no longer actionable.'))
                return True
            self._edit_capture[str(conn["owner_chat_id"])] = draft_id
            await answer(text=_ui("✎ Send me the text to deliver"))
            try:
                await edit_message_text(
                    text=(
                        self._render_resolved_message(draft, status="awaiting_edit")
                        + _ui("\n\n✎ Reply to this DM with the text you want delivered.")
                    ),
                    reply_markup=None,
                )
            except Exception:
                pass
            return True

        if choice == CHOICE_SEND:
            if not conn.get("can_reply"):
                await answer(
                    text=(
                        _ui("⚠️ Send-on-your-behalf is OFF — enable it in Telegram → "
                        "Business → Chatbots, then try again.")
                    )
                )
                return True
            draft = self._db.claim_business_draft(draft_id, caller_user_id)
            if not draft:
                await answer(text=_ui('That draft is no longer actionable.'))
                return True
            try:
                sent = await self._send(
                    chat_id=int(draft["customer_chat_id"]),
                    text=draft["draft_text"],
                    business_connection_id=draft["connection_id"],
                )
            except Exception:
                self._db.resolve_telegram_business_draft(draft_id, status='failed', send_token=draft['send_token'])
                logger.warning("Business send failed")
                await answer(text=_ui("⚠️ Send failed; check Telegram before trying another draft."))
                return True

            await self._record_sent(draft, sent, draft['draft_text'], edited=False)
            self._db.resolve_telegram_business_draft(
                draft_id, status="sent", final_sent_text=draft["draft_text"], send_token=draft['send_token'],
            )
            await answer(text=_ui("✓ Sent"))
            try:
                await edit_message_text(
                    text=self._render_resolved_message(draft, status="sent"),
                    reply_markup=None,
                )
            except Exception:
                pass
            return True

        await answer(text=_ui("Unknown action."))
        return True

    # ------------------------------------------------------------------
    # Owner-side "next message after Edit = the actual reply text" capture.
    # ------------------------------------------------------------------

    async def _record_sent(self, draft, sent, text, *, edited):
        scope = json.loads(draft['scope'])
        message_id = str(getattr(sent, 'message_id', '') or ('send:' + str(draft['draft_id'])))
        stamp = getattr(sent, 'date', None)
        event_at = stamp.timestamp() if stamp is not None and hasattr(stamp, 'timestamp') else None
        self._db.record_business_message(scope, message_id, text,
            actor='owner' if edited else 'approved_ai', author_id=scope['owner'],
            origin='owner_edit_send' if edited else 'approved_send', send_claim=draft, event_at=event_at)
        if self._archive_context:
            await asyncio.to_thread(self._archive_context.archive_pending)

    async def maybe_handle_edit_capture(
        self,
        *,
        owner_chat_id: str,
        text: str,
        caller_user_id: Optional[str] = None,
    ) -> bool:
        """If the owner just tapped Edit, treat their next DM as the override.

        Returns True if the message was consumed by the edit-capture flow
        (so the caller shouldn't dispatch it to the normal command path).
        """
        draft_id = self._edit_capture.get(str(owner_chat_id))
        if draft_id is None:
            return False
        draft = self._db.get_telegram_business_draft(draft_id)
        conn = self._db.get_telegram_business_connection(draft['connection_id']) if draft else None
        if not conn or not caller_user_id or str(caller_user_id) != conn['owner_user_id'] or str(owner_chat_id) != conn['owner_chat_id']:
            return False
        self._edit_capture.pop(str(owner_chat_id), None)

        from agent.memory_manager import _redact_for_provider
        override = _redact_for_provider((text or "").strip())[:4000]
        if not override:
            # Empty edit attempt → restore capture and let the user retry.
            self._edit_capture[str(owner_chat_id)] = draft_id
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=_ui("✎ Edit cancelled (empty text). Tap Edit again if you want to try."),
                    disable_notification=True,
                )
            except Exception:
                pass
            return True

        draft = self._db.get_telegram_business_draft(draft_id)
        if not draft or draft.get("status") not in {"pending", "awaiting_edit"}:
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=_ui("That draft has expired or was already resolved."),
                    disable_notification=True,
                )
            except Exception:
                pass
            return True

        conn = self._db.get_telegram_business_connection(draft["connection_id"])
        if not conn:
            return True
        if not conn.get("can_reply"):
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=(
                        _ui("⚠️ Send-on-your-behalf is OFF in Telegram → Business → "
                        "Chatbots. I can't deliver this — copy the text and send it "
                        "manually.")
                    ),
                    disable_notification=False,
                )
            except Exception:
                pass
            return True

        draft = self._db.claim_business_draft(draft_id,caller_user_id,action='edit_send')
        if not draft:
            return True
        try:
            sent = await self._send(
                chat_id=int(draft["customer_chat_id"]),
                text=override,
                business_connection_id=draft["connection_id"],
            )
        except Exception:
            self._db.resolve_telegram_business_draft(draft_id,status='failed',send_token=draft['send_token'])
            logger.warning("Business edit-send failed")
            try:
                await self._send(
                    chat_id=int(owner_chat_id),
                    text=_ui("⚠️ Send failed; check Telegram before trying another draft."),
                    disable_notification=False,
                )
            except Exception:
                pass
            return True

        await self._record_sent(draft,sent,override,edited=True)
        self._db.resolve_telegram_business_draft(
            draft_id, status="edited", final_sent_text=override, send_token=draft['send_token'],
        )
        try:
            await self._send(
                chat_id=int(owner_chat_id),
                text=_ui(f"✓ Sent (edited):\n\n{override}"),
                disable_notification=True,
            )
        except Exception:
            pass
        return True

    # ------------------------------------------------------------------
    # /biz slash command (owner-only).
    # ------------------------------------------------------------------

    async def handle_biz_command(
        self,
        *,
        owner_user_id: str,
        owner_chat_id: str,
        args: List[str],
    ) -> str:
        """Process /biz subcommands.  Returns text the adapter should send back.

        Supported:
          /biz                 — status dashboard
          /biz pause           — set auto_draft=False on all this user's connections
          /biz resume          — set auto_draft=True on all this user's connections
          /biz off <chat_id>   — add a customer chat to the paused list
          /biz on  <chat_id>   — remove a customer chat from the paused list
        """
        connections = self._db.list_telegram_business_connections(
            owner_user_id=str(owner_user_id), enabled_only=False,
        )
        active = [c for c in connections if c.get("is_enabled")]

        if not args:
            return self._render_status(connections=connections, owner_chat_id=owner_chat_id)

        sub = args[0].lower()
        if sub in {"pause", "resume"}:
            target = (sub == "resume")
            if not active:
                return _ui("You don't have any active business connections.")
            for conn in active:
                self._db.set_telegram_business_auto_draft(
                    conn["connection_id"], auto_draft=target,
                )
            verb = _ui("▶ Resumed drafting.") if target else _ui("⏸ Paused drafting.")
            return _ui(f"{verb}  ({len(active)} connection{'s' if len(active) != 1 else ''})")

        if sub in {"off", "on"} and len(args) >= 2:
            chat_arg = args[1].strip()
            if not active:
                return _ui("You don't have any active business connections.")
            updated = 0
            for conn in active:
                paused = list(conn.get("paused_chats") or [])
                if sub == "off" and chat_arg not in paused:
                    paused.append(chat_arg)
                    self._db.set_telegram_business_paused_chats(
                        conn["connection_id"], paused,
                    )
                    updated += 1
                elif sub == "on" and chat_arg in paused:
                    paused.remove(chat_arg)
                    self._db.set_telegram_business_paused_chats(
                        conn["connection_id"], paused,
                    )
                    updated += 1
            if updated:
                verb = _ui("muted in") if sub == "off" else _ui("re-enabled for")
                return _ui(f"✓ Chat {chat_arg} {verb} {updated} connection(s).")
            return _ui(f"No change — {chat_arg} was already in that state.")

        return (
            _ui("Usage:\n"
            "  /biz             — show status\n"
            "  /biz pause       — pause drafting (still see messages)\n"
            "  /biz resume      — resume drafting\n"
            "  /biz off <id>    — mute drafting for one customer chat\n"
            "  /biz on  <id>    — re-enable drafting for one customer chat")
        )

    # ------------------------------------------------------------------
    # Rendering helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_draft_owner_message(
        *, customer_name: str, customer_text: str, draft_text: str
    ) -> str:
        """Build the plain-text owner-DM body that carries one draft."""
        return _ui(
            f"💬 {customer_name} wrote:\n"
            f"{_quote_block(customer_text)}\n\n"
            f"📝 Suggested reply:\n"
            f"{draft_text}"
        )

    @staticmethod
    def _render_resolved_message(draft: Dict[str, Any], *, status: str) -> str:
        """Re-render the owner DM after a button decision."""
        header = {
            "sent": _ui("✓ Sent"),
            "edited": _ui("✓ Sent (edited)"),
            "discarded": _ui("✕ Discarded"),
            "expired": _ui("⏰ Expired"),
            "awaiting_edit": _ui("✎ Edit"),
        }.get(status, status)
        return _ui(
            f"{header}\n\n"
            f"💬 Customer wrote:\n{_quote_block(draft.get('customer_text', ''))}\n\n"
            f"📝 Draft was:\n{draft.get('draft_text', '')}"
        )

    @staticmethod
    def _render_status(*, connections: List[Dict[str, Any]], owner_chat_id: str) -> str:
        if not connections:
            return (
                _ui("You haven't connected this bot to any Telegram Business account yet.\n\n"
                "Open Telegram → Settings → Business → Chatbots, paste my @username, "
                "and pick which chats I can see.")
            )
        lines = [_ui("📋 Business Mode status\n")]
        for c in connections:
            state = _ui("🟢 active") if c.get("is_enabled") else _ui("⚪ ended")
            auto = _ui("drafting ON") if c.get("auto_draft") else _ui("drafting PAUSED")
            send_perm = _ui("send ON") if c.get("can_reply") else _ui("send OFF")
            paused = c.get("paused_chats") or []
            paused_note = _ui(f" — muted chats: {', '.join(paused)}") if paused else ""
            lines.append(
                f"• {state}  ·  {auto}  ·  {send_perm}{paused_note}"
            )
        lines.append("")
        lines.append(
            _ui("Commands: /biz pause · /biz resume · /biz off <chat_id> · /biz on <chat_id>")
        )
        return "\n".join(lines)

    @staticmethod
    def _build_draft_keyboard(draft_id: int, *, can_reply: bool):
        """Construct the inline keyboard for one draft.

        Imported lazily so the module is importable when python-telegram-bot
        is missing (matches the lazy-deps pattern used elsewhere in the
        adapter).
        """
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        row = []
        if can_reply:
            row.append(InlineKeyboardButton(
                _ui("✓ Send"), callback_data=f"{CALLBACK_PREFIX}{CHOICE_SEND}:{draft_id}",
            ))
        row.append(InlineKeyboardButton(
            _ui("✎ Edit"), callback_data=f"{CALLBACK_PREFIX}{CHOICE_EDIT}:{draft_id}",
        ))
        row.append(InlineKeyboardButton(
            _ui("✕ Discard"), callback_data=f"{CALLBACK_PREFIX}{CHOICE_DISCARD}:{draft_id}",
        ))
        return InlineKeyboardMarkup([row])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _customer_display_name(message: Any) -> str:
    """Best-effort human name for the customer who sent ``message``."""
    user = getattr(message, "from_user", None)
    if user is not None:
        for attr in ("full_name", "first_name", "username"):
            val = getattr(user, attr, None)
            if val:
                return str(val)
    chat = getattr(message, "chat", None)
    if chat is not None:
        for attr in ("full_name", "title", "username"):
            val = getattr(chat, attr, None)
            if val:
                return str(val)
    return _ui("Customer")


def _quote_block(text: str, *, max_len: int = 600) -> str:
    """Render a customer message as a quoted block for the owner DM."""
    if not text:
        return _ui("  (no text)")
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return "\n".join(f"  > {line}" for line in text.splitlines())
