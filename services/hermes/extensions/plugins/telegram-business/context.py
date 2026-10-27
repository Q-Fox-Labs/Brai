"""Bounded, recipient-only packet for a tool-free completion."""
import json
from datetime import datetime, timezone
from pathlib import Path


class DraftContext:
    def __init__(self, db, home):
        self.db = db
        self.home = Path(home).resolve()
        self.memory = None
        self.provider = None

    def _memory(self):
        if self.memory is None:
            config = json.loads((self.home / 'memos-rest.json').read_text())
            if not config.get('routing_enabled') or not config.get('enabled', True) or config.get('suspended'):
                return None
            from plugins.memory import load_memory_provider
            from importlib import import_module
            provider = load_memory_provider('memos-rest', register_skills=False)
            if provider is None:
                return None
            provider.initialize('telegram-business-context', hermes_home=str(self.home), agent_context='business')
            module = import_module(provider.__class__.__module__.rsplit('.', 1)[0] + '.business')
            self.provider = provider
            self.memory = module.BusinessMemory(provider)
            provider.outbox.start()  # Reuse the existing guarded, process-locked delivery queue.
        return self.memory

    def archive_pending(self):
        try:
            memory = self._memory()
            if memory is None:
                return
            for row in self.db.iter_pending_business_archives():
                try:
                    scope = json.loads(row['scope'])
                    self.db._validate_scope(scope)
                    event = memory.archive(scope, row)
                    if event:
                        self.db.mark_business_archived(scope, row['message_id'], row['revision'])
                except Exception:
                    continue  # Keep unsent archive durable locally; never log content.
        except Exception:
            return

    def prepare(self, text, scope):
        self.db._validate_scope(scope)
        from agent.memory_manager import _redact_for_provider
        self.archive_pending()
        memories = []
        try:
            memory = self._memory()
            if memory:
                memories = memory.recall(scope, text, lambda mid, rev, author, actor, evidence:
                    self.db.business_source_valid(scope, mid, rev, author, actor, evidence))
        except Exception:
            pass  # MemOS outage: same-chat local context only; no global fallback.
        history = []
        budget = 7000
        for row in reversed(self.db.business_history(scope)):
            entry = {'message_id':row['message_id'], 'text':row['text'][:1000], 'actor':row['actor'],
                     'author':row['author_id'], 'origin':row['origin'], 'date':row['updated_at']}
            cost = len(json.dumps(entry,ensure_ascii=False))
            if cost > budget:
                break
            history.append(entry)
            budget -= cost
        history.reverse()
        # Style shows only owner-authored language, never AI proposals or approved AI.
        # No text samples by default: scoped history already provides the safe examples.
        return _redact_for_provider({'current_time':datetime.now(timezone.utc).isoformat(), 'timezone':'UTC',
            'current_message':str(text)[:4000], 'recent_history':history, 'conversation_summary':'',
            'memories':memories, 'approved_owner_public_facts':[], 'style_examples':[],
            'relationship':'', 'owner_policy':{'new_commitments_allowed':False}})
