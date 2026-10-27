## Recipient-private contextual drafts

The real registered completion uses the profile-local `reply-prompt.md`, with no old four-sentence suffix, global SOUL, memory files or tools. The bounded JSON packet is untrusted data: up to 20 recent messages (7,000 character history budget), six source-grounded memories and the current text (4,000 characters). Approved public owner facts, relationship and separate style examples are empty by default. Time is explicitly UTC. Completion budget: 700 output tokens / 60 seconds.

Scope comes only from the persisted enabled Telegram connection and private chat: profile, owner/account, connection, chat and recipient. Unknown/mismatched/disabled scopes fail closed. Edits invalidate stale facts; deletion tombstones prevent delayed replay. New messages invalidate both pending and reserved-edit drafts. Send/Edit are authenticated and atomically claimed before I/O, including across two SQLite instances. Failed/uncertain sends are not automatically retried; check Telegram before generating another draft.

MemOS writes use the existing `MemOSProvider`, `RoutedRuntime` and durable `Outbox`, retaining scope, actor, author, origin, source and observed/sent status through every taxonomy copy. Local pending observations survive restart and are handed off on subsequent business updates/context preparation. An archive/classification outage does not block local history drafting. Immutable old archive revisions remain private historical records, but current SQLite source validation excludes edits/deletions from drafting recall.

Business recall never calls broad semantic search. It uses scope-qualified listings (at most three 100-row pages per cube, a four-second overall retrieval budget), validates all provenance locally, and returns only source quotes also present in the live same-chat record. The installed backend may ignore metadata filters: bounded local filtering trades recall completeness for isolation. Topic cubes and technical root are not ACLs. Generic MemOS recall/read/search/replace/forget exclude business-private records even for the same owner; raw administrative API access is privileged, not a customer boundary.

Recognized secrets are redacted at storage/egress; arbitrary non-pattern secrets cannot be guaranteed detected. Errors/logs omit message/exception content. No auto-send is added, and `/biz pause` still pauses drafting while observed history remains durable.

Activation requires independent review and refresh of **both** Telegram callbacks and existing MemOS provider objects. Reloading only Telegram is insufficient to prove the generic-memory privacy guard is live. This implementation did not restart the gateway or activate production delivery.

## Tests

```bash
python3 -m pytest
```

57 tests cover lifecycle, scoped history, migration, edits/deletions/replay, concurrent approval, all-action callback owner-scope validation, secret boundaries, ContextVar propagation, contextual completion and `/biz`. Unit tests have no network or live Telegram. The separate real-backend/no-send probe and repeatable suite runner are in the authorized scratch workspace; their results do not establish live customer delivery.

## Credits

Based on the design and implementation from [hermes-agent#30055](https://github.com/NousResearch/hermes-agent/pull/30055), replatformed as a standalone plugin. Related earlier community proposals: [#26654](https://github.com/NousResearch/hermes-agent/pull/26654) by @evgyur (earliest submission), [#35342](https://github.com/NousResearch/hermes-agent/pull/35342) by @MilekhinAV, [#46728](https://github.com/NousResearch/hermes-agent/pull/46728) by @kxnkxv.

## License

MIT
