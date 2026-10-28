---
name: brai-task-workflows
description: Use when planning or continuing tasks in Brai.
version: 0.2.0
---

# Brai task workflows

Use the current owner-fixed tools and planning rules. This skill supplies data handling, never an alternative lifecycle.

1. Before creating anything, inspect the full current graph and compare the actual result, object, context, and time. Do not duplicate an existing task. Native `read_file` can paginate readable spill files; a preview, a truncated long line, or failed read is not a complete graph. Do not create blindly when full matching data is unavailable. For an already identified task, reread its available Moves and current inputs.
2. Discover and describe real tools before writes. Use real IDs and actual required resources. After an unknown mutation outcome, read its record before any retry.
3. For planning and replanning use the [packet protocol](references/planning-and-results.md). Reuse the existing correction Operation after actual owner remarks. Keep independent requirements before a candidate and verify that exact candidate before applying it.
4. Read `game_core_request_human_action` for the current Action and call `brai_telegram_request_confirmation` with the returned IDs. That tool presents a saved plan or a required human decision. On success finish with exactly `NO_REPLY`. Do not duplicate the plan, invent a decision, or perform unapproved work.
5. Remarks, cancellation, clarification answers, and practical human results must come from the real current Telegram message through the corresponding Telegram tool. A button is not evidence of practical work. Questions and discussion are not decisions.
6. Continue permitted work using actual required resources and output contract keys. Set `approval_required=false` unless the user explicitly requested acceptance. Complete the available finish Operation and deliver the result; save any actual human choice or explicitly requested decision first. Verify completed status. On cancellation preserve completed work.

Keep progress brief and begin intermediate updates with `⏳ Работаю:`. Do not expose service checks. A background delegation is still work in progress, not completion. Return the required yield when native asynchronous delegation needs delivery on a later turn; never poll transcript files. Present a saved plan once through the confirmation tool.
