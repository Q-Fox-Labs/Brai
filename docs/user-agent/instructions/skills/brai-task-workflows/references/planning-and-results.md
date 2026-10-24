# Planning packets and result contracts

## Independent planning through owner tools

1. Claim the existing available planning Operation with its actual required input IDs. The independent reviewer receives the original attempt ID and packet before any candidate exists.
2. Call `elements_planning_packet_read({attempt_id})` directly through the normal tool dispatcher. It returns the complete `file_sha256` map and current source revision. This is a bounded owner packet reader; it cannot read arbitrary paths or execute code.
3. Read every named file with `elements_planning_packet_read({attempt_id,file_name,offset:0,limit:12000})`. Continue at each returned `next_offset` until null. Names must come from `file_sha256`. Read all packet, input/context, and rule files, preserving the same attempt and revision. The hash is always of the complete original UTF-8 text, regardless of the slice.
4. The reviewer independently derives result/condition requirements with exact source quotes. Record the returned complete `file_sha256` map in baseline.inputs, then call `elements_planning_bind` directly with that baseline. Do not substitute the aggregate `inputs_sha256`. Bind validates the exact file bytes with the accepted planner and returns `baseline_sha256`.
5. The author calls `elements_planning_build` directly with the candidate and same attempt. The same reviewer receives the full exact candidate and compiled output, preserves the fixed baseline, and checks all coverage, dependencies, resources, and roles. Use returned `baseline_sha256` and `candidate_sha256`; no local hashing is needed.
6. Only `elements_planning_apply` with that actual independent review and exact returned candidate hash can release the plan. The owner validates the real receipt. A build or reviewer accept is not owner approval. Request a fresh Telegram Accept after successful apply.

Do not use `execute_code`, terminal, private Python APIs, or local filesystem copies to retrieve or hash ordinary planning data. There is no need to save or retype a packet. Do not call `hermes_tools._call`.

A normative `INVALID_ARGUMENT` is a rejected input, not evidence that the service is unavailable. Read its `diagnostic.phase` and `diagnostic.reason`, reread the relevant original packet file, and correct the rejected data before another call. For example, `Нет основания требования` means that the reviewer must check the exact `source_file` and literal `quote`. Before a successful bind, the independent reviewer can correct the unbound baseline from the original source; never invent support or drop an actual requirement to pass validation. After bind, preserve the fixed baseline and correct only the candidate or review as appropriate. Continue the same running attempt and revision after a confirmed rejection. Do not repeat unchanged arguments or declare a technical outage solely from this code.

An unavailable reader, denied permission, or a requirement without a real source is a concrete limit; report it without bypassing permissions or weakening the requirements. For a stale revision reread owner state; for an unknown mutation outcome reconcile it before any retry. A pending approval is not a refusal or permission to rerun equivalent code. Preserve actual input facts and original dates; do not turn old plan wording into a new user requirement.

## Saving outputs

An ordinary content-producing Operation completes with `result.resources`. Each resource contains the actual complete content and the current output contract key in `metadata.output_key`. Never use placeholder IDs in live calls. The logical output key may differ from the new resource ID. After completion read available Moves and verify the saved output and next gate.

For rework use actual conditions and resolved required resources; older fields can refer to superseded versions. Keep accepted content unchanged. A final result is completed only after the real owner decision and the available finish Operation have been saved and read back.
