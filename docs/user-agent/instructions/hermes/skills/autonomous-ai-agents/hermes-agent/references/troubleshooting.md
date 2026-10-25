# Troubleshooting

### Voice not working
1. Check `stt.enabled: true` in config.yaml
2. Verify provider: `python -c "import pm; pm.sync_venv(['stt-whisper'], explicit=True)"` or set API key
3. In gateway: `/restart`. In CLI: exit and relaunch.

### Tool not available
1. `hermes tools` — check if toolset is enabled for your platform
2. Some tools need env vars (check `.env`)
3. `/reset` after enabling tools

### Model/provider issues
1. `hermes doctor` — check config and dependencies
2. `hermes auth` — re-authenticate OAuth providers (or `hermes auth add <provider>`)
3. Check `.env` has the right API key
4. **Copilot 403**: `gh auth login` tokens do NOT work for Copilot API. You must use the Copilot-specific OAuth device code flow via `hermes model` → GitHub Copilot.

### Changes not taking effect
- **Tools/skills:** `/reset` starts a new session with updated toolset
- **Config changes:** In gateway: `/restart`. In CLI: exit and relaunch.
- **Code changes:** Restart the CLI or gateway process

### web_extract shows a stale page (result caching)
`web_search`/`web_extract` cache results for 20 minutes (PR #94618) — a
repeat fetch of the same URL within the TTL is served from cache, which
can look like "my website changes aren't showing up."

Automatic carveouts (always fetched live, never cached):
- localhost / 127.0.0.1 / `*.local` / `*.localhost` / single-label LAN
  hostnames / private + link-local IP ranges (dev servers, hot-reload
  builds, chat-GUI artifact previews)
- URLs matched by `security.website_blocklist`
- failed responses and keyless-rescue-served responses

Developing a site tested over the PUBLIC internet (Vercel/Netlify
preview, ngrok/cloudflared tunnel, staging domain)? Public DNS isn't
auto-carved-out — list the host in config.yaml:

```yaml
web:
  cache_exempt_hosts:      # always fetched live; effective immediately
    - mysite.vercel.app
    - "*.ngrok-free.app"
    - mysite.dev           # suffix match: also covers preview.mysite.dev
```

Blunt instruments: `web.cache_ttl_minutes: 1` (min) or
`web.cache_enabled: false` disables both caches entirely.

### Skills not showing
1. `hermes skills list` — verify installed
2. `hermes skills config` — check platform enablement
3. Load explicitly: `hermes -s name` (or the skill's own `/<name>` slash command)

### Gateway issues
Check logs first:
```bash
grep -i "failed to send\|error" ~/.hermes/logs/gateway.log | tail -20
```

Common gateway problems:
- **Gateway dies on SSH logout**: Enable linger: `sudo loginctl enable-linger $USER`
- **Gateway dies on WSL2 close**: WSL2 requires `systemd=true` in `/etc/wsl.conf` for systemd services to work. Without it, gateway falls back to `nohup` (dies when session closes).
- **Gateway crash loop**: Reset the failed state: `systemctl --user reset-failed hermes-gateway`

### Platform-specific issues
- **Discord bot silent**: Must enable **Message Content Intent** in Bot → Privileged Gateway Intents.
- **Slack bot only works in DMs**: Must subscribe to `message.channels` event. Without it, the bot ignores public channels.
- **Windows-specific issues** (`Alt+Enter` newline, WinError 10106, UTF-8 BOM config, line endings): see `references/windows-quirks.md`.

### Auxiliary models not working
If `auxiliary` tasks (vision, compression, session_search) fail silently, the `auto` provider can't find a backend. Either set `OPENROUTER_API_KEY` or `GOOGLE_API_KEY`, or explicitly configure each auxiliary task's provider:
```bash
hermes config set auxiliary.vision.provider <your_provider>
hermes config set auxiliary.vision.model <model_name>
```

### Telegram Business drafts: profile scope lost in a worker

- Reproduce an `UnscopedSecretError` with the exact registered plugin draft generator under the host's multiplex flag, home override, and profile secret mapping. Use `PluginContext` and its real LLM facade for the live probe; replace only the state DB/manager construction to capture the closure. Never construct a live Telegram bot or invoke the manager's delivery pipeline during a no-send check.
- Add a deterministic regression before changing production code: bind an empty secret mapping, call the draft closure, and use the real `agent.secret_scope.get_secret("COPILOT_GITHUB_TOKEN")` in the injected completion. An empty mapping is valid; losing the mapping raises the reported error. Assert the worker retains the home override, stays off the event-loop thread, preserves drafting arguments, trims its result, and does not leak scope into a later bare executor job.
- Replace a bare `loop.run_in_executor(None, ...)` with `asyncio.to_thread(...)` (or `copy_context().run` when a specific executor is required). Do not put credentials in process-global environment variables or disable fail-closed profile isolation.
- Test provider routing independently after the scope regression passes. Persisted `model.provider: auto` can resolve to `openai-codex` for normal chat while an off-turn `ctx.llm.complete(task=None)` has no concrete runtime provider. The auxiliary discovery chain deliberately excludes Codex rather than guessing its supported model. A successful scope test therefore does not establish successful real drafting.
- Compare a config-default live probe with a temporary `scoped_runtime_main` binding to the host-resolved chat provider/model. If only the latter works, explicitly select the intended main provider through `hermes config set model.provider <provider>` when authorized; do not hardcode a provider inside the plugin or widen its override trust gates. Read back the provider and account for any old endpoint the CLI clears, then rerun the real config-default probe without the temporary binding: only that proves off-turn drafting works with persisted settings.
- Run the plugin's entire suite and record actual live draft text/provider/model separately from mocked regression output. A new failure such as `AuxiliaryClientUnavailable` is a remaining blocker, not a successful draft. Keep activation separate: source edits require the relevant process reload/restart, and must not restart a gateway without authorization.

### Telegram Business native callbacks: no initial profile scope

- Distinguish a lost worker context from a missing callback context. `asyncio.to_thread` preserves existing ContextVars but cannot create a home/secret scope absent from native PTB callbacks. Regress with the actual registered `telegram.ext.MessageHandler.callback`, multiplex active, no ambient home/secret binding, a real manager debounce task, and the host secret resolver; also test a foreign ambient scope and inherited matching scope.
- Capture the owning home at registration from the trusted host plugin manager's `home_path` (or the registration-time home on older hosts). Bind `gateway.run._async_profile_runtime_scope` at native message/approval/edit boundaries and deferred draft entry; reuse an inherited scope only when both its home override and stamped secret home match the registered home. Never hydrate credentials from customer-provided `scope['profile']`; validate recipient scope against the registered SQLite DB before deferred hydration. When rebinding absent/foreign provenance, wrap the host helper in `agent.auxiliary_client.scoped_runtime_main({})`: an inherited live main-runtime override can itself carry another profile's API key, even after rebinding `get_secret`. Preserve that runtime only with matching home/secret provenance and restore it on exit. Let the host helper reset tokens; retain `to_thread` for archive, prepare, and completion workers.
- Keep no-send real model checks separate from mocked callback regressions and activation. Import `gateway.run` before pytest starts capture in integration runners: host bootstrap can cache logging streams tied to pytest capture, obscuring final output. Verify exact full-suite counts and print an explicit runner result. Log exception type plus fixed stage only, not exception messages/tracebacks or customer content.

### "Reset permissions" / auto-approving everything
See `references/security-privacy.md` — wipe the "Always allow" stores, don't touch yolo mode.

