## Safety properties

- **No auto-send exists.** Every reply requires an owner button tap, even when `can_reply` is granted.
- **Owner-only buttons.** Callbacks are authorized against the connection's `owner_user_id`; anyone else gets `⛔`.
- **Drafts expire after 24h** (configurable). Stale buttons no-op.
- **Without `can_reply`, the Send button is hidden** — you're told to copy/paste manually instead of getting a button that silently fails.
- **Typing bursts coalesce** — new messages within the debounce window supersede the prior draft, one draft per coherent thought.

## Owner controls

| Command | Effect |
|---|---|
| `/biz` | status dashboard |
| `/biz pause` / `/biz resume` | global drafting kill switch |
| `/biz off <chat_id>` / `/biz on <chat_id>` | per-customer-chat mute |

## State

Plugin-owned SQLite at `$HERMES_HOME/telegram-business/state.db`: connections, drafts and recipient-scoped messages. Migration adds tables/columns without replacing existing connections or drafts; legacy unscoped drafts cannot be sent. Hermes' core state is never touched. Do not delete the database to upgrade.

## v1 limits

- **Text updates only** — customer media (photos, voice, documents, including media captions) is outside the registered text-update path.
- History begins with observed updates; past Telegram history is not imported. Incoming text, observed owner outgoing text and confirmed sends are distinct; proposals/discards/failed sends never enter spoken history.
- Same-chat owner edits/sent wording can inform tone through history. Approved AI sends and bot echoes are not owner-authored style samples. No model training, rolling summary or automatic public-owner-fact import is performed.

