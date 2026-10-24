# Providers & Model Aliases

Set via `hermes model` (picker) or `hermes setup`. 35+ provider profiles ship as
plugins under `plugins/model-providers/`; user plugins of the same name override.
Full docs: https://hermes-agent.nousresearch.com/docs/integrations/providers

### Providers

| Provider | Auth | Key env var(s) |
|----------|------|----------------|
| openrouter | API key | `OPENROUTER_API_KEY` |
| anthropic | API key | `ANTHROPIC_API_KEY` (also `CLAUDE_CODE_OAUTH_TOKEN`) |
| nous | OAuth device code | `hermes auth add nous` (or `NOUS_API_KEY`) |
| openai-codex | OAuth | `hermes auth add openai-codex` |
| qwen-oauth | OAuth | `hermes auth add qwen-oauth` |
| minimax-oauth | OAuth | `hermes auth add minimax-oauth` |
| copilot | Token | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` (Copilot device flow — `gh auth login` tokens do NOT work) |
| copilot-acp | External CLI | Copilot CLI on PATH or `COPILOT_CLI_PATH` |
| gemini | API key | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| xai | API key | `XAI_API_KEY` (SuperGrok OAuth also supported) |
| deepseek | API key | `DEEPSEEK_API_KEY` |
| zai (GLM) | API key | `GLM_API_KEY` / `ZAI_API_KEY` |
| minimax / minimax-cn | API key | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| kimi-coding / -cn | API key | `KIMI_API_KEY` / `KIMI_CN_API_KEY` |
| alibaba (+coding-plan) | API key | `DASHSCOPE_API_KEY` / `ALIBABA_CODING_PLAN_API_KEY` |
| xiaomi | API key | `XIAOMI_API_KEY` |
| huggingface | Token | `HF_TOKEN` |
| fireworks / novita / nvidia / deepinfra / gmi / arcee / stepfun / upstage / kilocode / ai-gateway / opencode-zen / opencode-go / ollama-cloud | API key | `<NAME>_API_KEY` |
| bedrock / vertex / azure-foundry | Cloud SDK / key | AWS SDK creds / Vertex ADC / `AZURE_FOUNDRY_API_KEY` |
| custom | Config | `model.base_url` + `model.api_key` in config.yaml |

### Telegram-only API key onboarding

- Read the active profile's `SECRETS.md` before accepting credentials. Never request an API key in Telegram messages or display server-side secrets in tool output.
- Check whether a verified Mini App intake already exists before building another. A form must validate signed Telegram `initData`, the exact requesting user, freshness, and an expiring single-use service/operation-bound token on submission; a private URL alone is not authentication.
- Preserve the root website when adding an intake route. With Caddy, use a prefix `handle` (not `handle_path`) and a separate fallback handler, validate and reload, then verify root response and HTTPS route independently.
- For Groq intake requests set an honest explicit User-Agent (for example `Hermes-Groq-Intake/1.0`). Groq's edge can reject the default Python urllib agent with HTTP 403 / Cloudflare 1010 before checking the key. Compare transport responses using a dummy key: HTTP 401 proves reaching authentication; it does not validate a real credential. Keep safe HTTP categories distinguishable from invalid-key errors without logging upstream bodies or credentials.
- Run synthetic-key tests through the public HTTPS path: foreign/stale/future identities, rejected credential, token reuse, no credential file publication, and absence of the probe/auth/token in both application and proxy logs. Keep proxy debug/body/access logging disabled and responses no-store.
- Deliver a Telegram `web_app` button in the authorized user's DM rather than an ordinary URL: normal browser openings do not provide signed `initData`. Keep bot tokens server-side; verify the exact button markup after delivery (Telegram's same-markup “message is not modified” response confirms persistence).
- Distinguish key validated/saved from provider activation. Intake alone must not switch a working voice provider or restart the gateway; connect the protected secret to the runtime, exercise transcription and text cleanup, then report each verified milestone separately.

Multiple credentials per provider pool and rotate automatically (`hermes auth`).
Fallback chain when the primary fails: `hermes fallback add|remove|list`.

### Subscription limits and reset times

1. Run `hermes usage --help` to confirm the installed command and flags, then `hermes usage --json` to fetch the configured provider's live account limits without starting an inference session. Use `--provider openai-codex` (or the requested provider) when the user asks about a different account; preserve the active profile.
2. Read `provider`, `plan`, `source`, `fetched_at`, `windows`, `details`, and `unavailable_reason`. Use `hermes usage` for the ready-made human-readable block if needed. These commands expose account limits without printing OAuth secrets; do not inspect or display raw auth files to answer a quota question.
3. Report the fetch timestamp, plan, remaining percentage for each returned window, and exact reset date/time with its timezone. JSON reports `used_percent`, so calculate remaining as `100 - used_percent` with a tool; the human-readable command already calculates it. Keep the chat response short and use bullets rather than a table.
4. Distinguish scheduled window resets from additional/banked reset credits. Only report banked resets when the response explicitly supplies them; an empty `details` list means their availability is unknown, not zero. Never treat `hermes auth reset` as a subscription reset: it clears local credential exhaustion state, not the provider's quota.
5. If fetching fails or `unavailable_reason` is set, report that blocker instead of estimating from conversation token counts or reusing an old snapshot. A command being supported does not guarantee every provider exposes every quota field.

### User-defined model aliases

Work with `/model <name>` in CLI and every gateway platform. Resolved by
`hermes_cli/model_switch.py::resolve_alias()`; user aliases are checked BEFORE
the built-in table, so a user `sonnet`/`grok` shadows the built-in.

```yaml
# Full form
model_aliases:
  fav:
    model: claude-sonnet-4.6
    provider: anthropic
  local-qwen:
    model: qwen3.5:397b
    provider: custom
    base_url: "https://ollama.com/v1"
  theta:
    model: theta-1
    provider: custom
    base_url: "https://theta.example.com/v1"
    key_env: THETA_API_KEY        # or: api_key: "${THETA_API_KEY}"

# Short form ("provider/model"), also via CLI:
#   hermes config set model.aliases.fav openrouter/anthropic/claude-sonnet-4.6
model:
  aliases:
    fav: openrouter/anthropic/claude-sonnet-4.6
```

`/model fav` — session-scoped; add `--global` to persist as default.

An alias with its own `base_url` authenticates with its own credential
(`api_key`, which also accepts a `"${VAR}"` reference, or `key_env`). With
neither set the key is resolved from the alias HOST, never carried over from
the provider that was active before the switch.

Built-in aliases (catalog-resolved against the active provider): `sonnet`,
`opus`, `haiku`, `claude`, `gpt5`, `gpt`, `codex`, `o3`, `o4`, `gemini`,
`deepseek`, `grok`, `llama`, `qwen`, `minimax`, `nemotron`, `kimi`, `glm`,
`step`, `mimo`, `trinity`.
