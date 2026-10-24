
# Hermes Agent

Hermes Agent is an open-source AI agent framework by Nous Research that runs in your terminal, a native desktop app, messaging platforms, and IDEs. It's in the same category as Claude Code (Anthropic), Codex (OpenAI), and OpenClaw — autonomous coding and task-execution agents that use tool calling to interact with your system. Hermes works with any LLM provider (OpenRouter, Anthropic, OpenAI, Google, DeepSeek, xAI, local models, and 20+ others) and runs on Linux, macOS, Windows, and WSL.

What makes Hermes different:

- **Self-improving through skills** — Hermes learns from experience by saving reusable procedures as skills that load into future sessions.
- **Persistent memory across sessions** — remembers who you are, your preferences, environment details, and lessons learned. Pluggable memory backends.
- **Multi-platform gateway** — the same agent runs on Telegram, Discord, Slack, WhatsApp, iMessage, Signal, Matrix, Teams, Email, and a dozen more platforms with full tool access, not just chat.
- **Many surfaces** — the same agent core drives the CLI, the Ink TUI, a native Electron desktop app, a web dashboard, and an ACP server for IDEs (VS Code / Zed / JetBrains).
- **Provider-agnostic** — swap models and providers mid-workflow; credential pools rotate across multiple API keys automatically.
- **Profiles** — run multiple independent Hermes instances with isolated configs, sessions, skills, and memory.
- **Extensible & themeable** — plugins, MCP servers, custom tools, webhook triggers, cron scheduling, skins that theme every surface, desktop UI plugins, TUI widgets, and pet mascots.

Read the SKILL.md routing table for other topics; this file covers installation checks and configuration preferences. Commands run from the skill directory.

**Docs:** https://hermes-agent.nousresearch.com/docs/

## Scope & Verification

This skill is a concise operating guide, not the complete source of truth for every Hermes feature. If a Hermes feature, command, or setting is not mentioned here or in a reference, do not treat that absence as evidence that it does not exist. Check the live repository and official docs before giving a negative answer.

Good verification targets, cheapest first:

- **Every shipped feature, one line each: https://hermes-agent.nousresearch.com/docs/llms.txt.** Start here for any "can Hermes do X?" or "how do I do X?" — it indexes the entire documentation set with a link to the page that answers. It is generated from the docs tree on every build, so it is never behind the product. Fetch it with `web_extract`, or `curl -s https://hermes-agent.nousresearch.com/docs/llms.txt` when web tools are off. The whole documentation set in one file is at `/docs/llms-full.txt`.
- CLI commands: `hermes --help`, `hermes <command> --help`, and `hermes_cli/main.py`
- Source tree: https://github.com/NousResearch/hermes-agent

Never answer "Hermes can't do that" from memory. Hermes ships far more than this skill body describes, and the index exists so a negative answer is always checkable.

## User-facing configuration preferences

- Write command-menu descriptions and user-facing plugin notices in plain Russian for a nontechnical reader: describe the action, result or recovery step, not internal implementation. Prefer «Начать новый разговор с чистого листа» over session IDs or context terminology. Preserve warnings about dangerous actions, permissions, overwrites, uploads, and possible extra charges; simplicity must not hide consequences. Check failure and approval messages too, because translating the menu alone leaves runtime notices untranslated.
- When asked to translate or simplify a menu, change descriptions only and preserve command names, order, and availability. Save custom wording in the active profile's locale overlay and verify every published entry; use `references/telegram-menu-localization.md` for the procedure.
- Keep global instructions short: add a conditional pointer to the active profile's `SOUL.md`, and put detailed topical recommendations in a separate profile-local instruction file or an existing skill reference. Do not use a cwd-dependent `AGENTS.md` as a guarantee that every new Telegram topic will load those rules. Read the destination first and preserve unrelated content.
- Design onboarding for a Telegram-only user: perform server work yourself and ask the user only for account-side actions. Do not request credentials in chat or treat a proposed secure form as a deployed feature.
- Host provider-connection forms on a dedicated non-root URL path or an explicitly approved subdomain; preserve the existing site's root and unrelated routes. Confirm the placement before deployment, because permission to use a domain is not permission to replace its homepage.
- Resolve an ambiguous «connect provider» request before making configuration changes: distinguish main-model inference, speech recognition, transcript cleanup and speech synthesis. Configure only the requested stages; a voice-processing integration does not authorize replacing the main model or reply voice.
- Distinguish messages to the bot from messages to the owner's personal Telegram account before choosing an integration. Verify current official menu labels instead of repeating a plugin README's possibly old wording. For Telegram streaming and personal-account reply plugins, load `references/telegram-operations.md`.
- Preserve the user's selected recipients, allowlists and confirmation policy while diagnosing an integration; do not broaden access to make a test pass. Reproduce an incoming-message failure at the native SDK callback boundary before treating an isolated model call as a fix.
- Report configuration saved, runtime activated, real generation tested, and end-to-end delivery verified as separate milestones; none implies the others. Match callback tests to the gateway's actual profile/credential context, including absent or foreign ambient bindings, because a manually scoped probe can hide a live failure. For private-memory or owner-account integrations, require independent privacy/concurrency review before activation; a passing suite is not evidence that untested interleavings are safe.

## Quick Start

```bash
# Install (shell installer — bootstraps PM, Python, dependencies, and the launcher)
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# Interactive chat (default surface; set display.interface: tui to launch the Ink TUI instead)
hermes

# Single query
hermes chat -q "What is the capital of France?"

# Setup wizard  /  pick model+provider  /  health check
hermes setup
hermes model
hermes doctor

# Other surfaces
hermes desktop                 # launch the native desktop app (alias: hermes gui)
hermes dashboard               # web admin panel + embedded chat
hermes proxy                   # OpenAI-compatible local proxy backed by your OAuth provider
```

## Key Paths

```
~/.hermes/config.yaml       Main configuration (settings — never secrets)
~/.hermes/.env              API keys and secrets ONLY (under $HERMES_HOME if set)
$HERMES_HOME/skills/        Installed skills
~/.hermes/skins/            Custom themes (see references/themes.md)
~/.hermes/desktop-plugins/  Desktop app UI plugins (see references/desktop-plugins.md)
~/.hermes/tui-widgets/      TUI widget apps (see references/tui-widgets.md)
~/.hermes/pets/             Installed pet mascots (see references/petdex.md)
~/.hermes/state.db          Canonical session store (SQLite + FTS5)
~/.hermes/sessions/         Gateway routing index, request dumps, *.jsonl transcripts
~/.hermes/logs/             Gateway and error logs
~/.hermes/auth.json         OAuth tokens and credential pools
~/.hermes/hermes-agent/     Source code (if git-installed)
```

Profiles use `~/.hermes/profiles/<name>/` with the same layout. When a profile is active, resolve the real home from `$HERMES_HOME` — never hardcode `~/.hermes`.

