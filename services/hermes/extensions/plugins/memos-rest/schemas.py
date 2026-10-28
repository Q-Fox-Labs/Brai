# ABOUTME: Описывает инструменты памяти, доступные модели Hermes.
# ABOUTME: Явный поиск не ограничивается размером автоматической подстановки контекста.
"""Provider tools, separate from Hermes's built-in memory tool."""


def schema(name, description, properties=None, required=()):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties or {}, "required": list(required)}}


TOOLS = [
    schema("memos_search", "Search the existing MemOS memory across sessions. Returns ranked fragments with IDs and provenance.", {
        "query": {"type": "string", "description": "Question or information to recall."},
        "top_k": {"type": "integer", "minimum": 1, "description": "Optional result count, e.g. 1000; omitted returns all relevant matches. No fixed upper cap."},
    }, ("query",)),
    schema("memos_remember", "Explicitly store a fact, preference or decision in MemOS. Reports verified only after reading the saved record back; pending means delivery is still queued.", {
        "content": {"type": "string", "description": "Text to remember. Never intentionally include credentials or other secrets."},
    }, ("content",)),
    schema("memos_read", "Read a specific memory ID in the configured MemOS cube, including its session and author.", {
        "memory_id": {"type": "string", "description": "ID returned by memos_search or memos_remember."},
        "include_transcript": {"type": "boolean", "description": "Include the original scrubbed dialogue for this record, default false."},
    }, ("memory_id",)),
    schema("memos_forget", "Delete only the specified memory ID in the configured MemOS cube and verify deletion. Use when the user requests forgetting a particular memory.", {
        "memory_id": {"type": "string", "description": "Exact ID to forget."},
    }, ("memory_id",)),
    schema("memos_status", "Check MemOS service reachability and the count of pending and verified deliveries."),
]

# Selected once when a provider/session is constructed; never reload mid-session.
from copy import deepcopy
ROUTED_TOOLS = deepcopy(TOOLS)
for tool in ROUTED_TOOLS:
    if tool['name'] in ('memos_search', 'memos_remember'):
        tool['parameters']['properties']['project'] = {'type': 'string', 'description': 'Explicit approved project catalog ID; overrides session binding.'}
    if tool['name'] == 'memos_search':
        tool['parameters']['properties']['include_archive'] = {'type': 'boolean', 'description': 'Also search original dialogue, including pending or rejected material. Default false: only useful extracted facts.'}
        tool['parameters']['properties']['cubes'] = {'type': 'array', 'items': {'type': 'string'}, 'description': 'Optional approved initial cube scope; may widen only inside authorized scope.'}
    if tool['name'] == 'memos_remember':
        tool['parameters']['properties']['operation_id'] = {'type': 'string', 'description': 'Optional stable request ID for repeat/recovery.'}
        tool['parameters']['properties']['shared_infra'] = {'type': 'boolean', 'description': 'Explicitly share grounded infra copies for read-only recall; requires catalog permission, default false.'}
    if tool['name'] in ('memos_read', 'memos_forget'):
        tool['description'] = tool['description'].replace('configured MemOS cube', 'authorized managed MemOS cubes')
ROUTED_TOOLS.append(schema('memos_replace', 'Correct exactly one logical fact across all its managed copies. Preserves logical ID, reroutes memberships, and verifies replacement/removal. Use only for an explicit user correction.', {
    'memory_id': {'type': 'string', 'description': 'Exact physical or logical memory ID.'},
    'content': {'type': 'string', 'description': 'Grounded corrected fact, without secrets.'},
    'operation_id': {'type': 'string', 'description': 'Optional stable correction request ID for safe replay.'},
}, ('memory_id', 'content')))
