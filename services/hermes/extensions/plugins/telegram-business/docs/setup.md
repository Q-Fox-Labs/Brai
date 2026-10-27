# hermes-telegram-business

**Observe-with-approval Telegram Business Mode (secretary bot) for [Hermes Agent](https://github.com/NousResearch/hermes-agent).**

Connect your Telegram Business account to your Hermes bot and it becomes your secretary: every incoming customer message gets an LLM-drafted reply delivered to **your** DM with inline buttons — **nothing reaches the customer until you tap Send.**

```
Customer → your Business account (via Business Mode)
            ↓ debounce 8s, draft once
Bot → your DM
       💬 Carol wrote:
         > Hey, are you free Friday afternoon?

       📝 Suggested reply:
       What did you have in mind?

       [✓ Send]   [✎ Edit]   [✕ Discard]
            ↓
Send    → delivered to the customer via your Business connection
Edit    → your next DM text becomes the outgoing message
Discard → dropped, the customer sees nothing
```

## Requirements

- Hermes Agent with plugin Telegram-handler support (`ctx.register_telegram_handler`, hermes-agent PR #59159 / v0.18+)
- A Telegram **Business** subscription on your personal account
- Your Hermes Telegram bot with **Business Mode** toggled on in [@BotFather](https://t.me/BotFather)
- python-telegram-bot ≥ 21.1 (already installed with the Hermes Telegram platform)

## Install

```bash
git clone https://github.com/NousResearch/hermes-telegram-business \
    ~/.hermes/plugins/telegram-business
hermes plugins enable telegram-business
```

Restart the gateway (`hermes gateway restart`). Then:

1. @BotFather → your bot → **Business Mode** → enable.
2. Telegram → **Settings → Business → Chatbots** → add your bot → pick which chats it can see, and whether it can **reply on your behalf** (needed for the Send button).
3. Message your bot `/biz` to confirm the connection is live.

## Configuration

Optional block in `~/.hermes/config.yaml`:

```yaml
plugins:
  entries:
    telegram-business:
      debounce_seconds: 8        # coalesce typing bursts
      draft_ttl_hours: 24        # stale-draft expiry
      max_customer_text_chars: 4000
      prompt_file: telegram-business/reply-prompt.md
```

Drafting uses your active Hermes model through the host-owned plugin LLM surface (`ctx.llm`) — no separate API key.

