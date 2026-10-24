# Translate and simplify Telegram command descriptions

Use for localization or plain-language rewriting of slash-menu descriptions without changing command identifiers.

## Procedure

1. Inspect the installed Telegram adapter and `hermes_cli/commands_platforms.py`. Confirm that registry descriptions resolve through `CommandDef.describe()` and `slash.<canonical-name>.description`; identify the active profile and desired locale.
2. For a language change, run `hermes config set display.language ru` (or the requested supported language), then read it back. This localizes static UI broadly, not only the menu. For wording-only changes, keep the existing language setting.
3. Read the current menu through `getMyCommands` for default, all_private_chats, all_group_chats, and the exact current-chat scope, including existing language-specific variants. Save a credential-free backup with a unique filename; do not overwrite the original backup on retries. Narrow chat-scoped menus override generic menus.
4. Draft short descriptions stating the visible action and outcome. Keep warnings about dangerous execution, overwrites, uploads, and extra charges. Preserve names, order, and command availability; do not simplify wording by inventing behavior.
5. Persist custom descriptions in `$HERMES_HOME/locales/<lang>.yaml`, merging any existing overlay. Use keys such as:

   ```yaml
   slash:
     new:
       description: "Начать новый разговор с чистого листа"
     codex-runtime:
       description: "Выбрать способ подключения моделей OpenAI и Codex"
   ```

   Use the canonical registry name in locale keys, not Telegram's sanitized spelling. Telegram changes hyphens to underscores, so `/codex_runtime` resolves from `slash.codex-runtime.description`; an underscore key silently fails to override the bundled translation. Derive mappings from the registry rather than guessing.
6. Generate the menu with `telegram_menu_commands(max_commands=telegram_menu_max_commands())`, not the helper's default cap. Inspect every actual visible description: core registry descriptions localize, but skill/plugin descriptions may come directly from metadata. Compare names and counts against the exact target menu, and ensure every entry requested for rewriting has the intended text. Two sample rows are not proof of full coverage.
7. For immediate publication without restarting an active gateway, resolve credentials within the active profile's process configuration, call `getMe`, and confirm the username is the current bot. Never print tokens or token-bearing request URLs. Publish via `setMyCommands` with explicit scope and language_code, preserving existing names and order. Populate generic scopes only as the native adapter would.
8. Read back each exact scope/language and compare the complete returned list to the intended payload. Report remote verification separately from the user's cached interface; suggest closing and reopening the menu if necessary.
9. Keep the locale overlay and language setting so future gateway registration preserves the wording. A running process may retain cached translations; don't claim an external CLI write refreshes its cache automatically or restart it unnecessarily during the active turn.

## Checks and pitfalls

- Compare against an immutable pre-change snapshot, not a backup rewritten during each apply; otherwise a changed-count check can misleadingly report zero or only the last few edits.
- Validate semantic scope: `/start` may be a silent platform acknowledgement, not a greeting workflow; don't turn it into «Познакомиться с ботом» unless the handler does that.
- Distinguish menu registration from assistant text aliases. Telegram command names accept lowercase ASCII letters, digits, and underscores, not Cyrillic. Russian descriptions are fine; `/голос` in an instruction file is not a registered menu command. Verify current API rules when answering registration questions.
- In a packaged installation, run probes through the existing Hermes runtime/bootstrap so imports use its dependencies. Do not install a duplicate dependency set solely for a menu probe.
