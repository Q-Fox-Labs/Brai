"""Recipient-private access through the existing routed durable writer.

No generic recall/search is used: this deployment's search session is only a
ranking hint. Bounded, scope-qualified listings are checked locally before any
text reaches a drafting model. Taxonomy cubes are not access-control boundaries.
"""
import re
import time
from pathlib import Path

from .client import memory_rows, MemOSError
from .provider import digest, scrub


class BusinessMemory:
    def __init__(self, provider):
        self.provider = provider
        if provider.routing is None:
            raise MemOSError('Business memory requires the scoped routed runtime')

    def valid_scope(self, scope):
        keys = {'profile', 'owner', 'account', 'connection', 'chat', 'recipient'}
        return (isinstance(scope, dict) and set(scope) == keys
                and all(isinstance(v, str) and v for v in scope.values())
                and scope['profile'] == str(Path(self.provider.home).resolve())
                and scope['owner'] == scope['account'] and scope['chat'] == scope['recipient'])

    def archive(self, scope, row):
        if not self.valid_scope(scope):
            raise MemOSError('Invalid business scope')
        actor = row['actor']
        if actor not in ('customer', 'owner', 'approved_ai'):
            raise MemOSError('Invalid business actor')
        scope_id = digest(scope)
        sid = 'telegram-business:' + scope_id
        extra = {'hermes_visibility': 'business_private', 'hermes_business_scope': scope,
                 'hermes_business_scope_id': scope_id, 'hermes_subject_id': scope['recipient'],
                 'hermes_business_message_id': row['message_id'], 'hermes_business_revision': row['revision'],
                 'hermes_business_actor': actor, 'hermes_business_origin': row['origin'],
                 'hermes_business_status': 'observed' if actor == 'customer' else 'sent',
                 'hermes_business_date': row['created_at']}
        return self.provider._archive(
            [{'role': 'assistant' if actor == 'approved_ai' else 'user', 'content': row['text']}],
            sid, 'business_message', [scope_id, row['message_id'], row['revision']],
            author={'id': row['author_id'], 'is_bot': actor == 'approved_ai'}, extra=extra)

    def recall(self, scope, query, validate_source):
        if not self.valid_scope(scope):
            return []
        runtime = self.provider.routing
        config = runtime.reload()
        if not config.get('enabled', True) or config.get('suspended'):
            return []
        scope_id = digest(scope)
        sid = 'telegram-business:' + scope_id
        candidates = {}
        deadline = time.monotonic() + 4.0
        for cube in runtime.catalog.cubes:
            client = runtime.client(cube)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            # AIDEV-NOTE: Legacy PostgreSQL игнорирует HTTP pagination; scoped get
            # использует negotiated stream и не повторяет полную выгрузку трижды.
            rows = client.get({'info.hermes_business_scope_id': scope_id, 'session_id': sid},
                              timeout=min(float(config.get('request_timeout', 30)), 3, remaining))
            for row in rows:
                meta = row.get('metadata') or {}
                info = meta.get('info') or {}
                actor = info.get('hermes_business_actor')
                origin = info.get('hermes_business_origin')
                if (row.get('_cube_id') != cube or meta.get('user_id') != config['user_id']
                        or meta.get('session_id') != sid or info.get('hermes_cube') != cube
                        or cube not in info.get('hermes_memberships', [])
                        or info.get('hermes_home_scope') != runtime.home_scope
                        or info.get('hermes_memory_epoch') != config['memory_epoch']
                        or info.get('hermes_visibility') != 'business_private'
                        or info.get('hermes_business_scope') != scope
                        or info.get('hermes_business_scope_id') != scope_id
                        or info.get('hermes_subject_id') != scope['recipient']
                        or info.get('hermes_kind') not in ('business_message', 'fact')
                        or actor not in ('customer', 'owner', 'approved_ai')
                        or origin not in ('telegram_incoming','telegram_edited','telegram_owner','approved_send','owner_edit_send','telegram_bot_echo')
                        or info.get('hermes_business_status') != ('observed' if actor == 'customer' else 'sent')):
                    continue
                if info.get('hermes_kind') == 'fact' and (not info.get('hermes_source_ids') or not info.get('hermes_source')):
                    continue
                # Draft from source evidence, not an unverified backend paraphrase.
                source = info.get('hermes_source') or {}
                evidence = (source.get('quote') if info.get('hermes_kind') == 'fact' else
                            '\n'.join(m.get('content','') for m in info.get('hermes_messages',[]) if isinstance(m,dict)))
                if not isinstance(evidence,str) or not evidence or not validate_source(
                        info.get('hermes_business_message_id'), info.get('hermes_business_revision'),
                        info.get('hermes_author_id'), actor, evidence):
                    continue
                text = scrub(evidence)[:1000]
                key = info.get('hermes_logical_id') or row.get('id')
                if text and key:
                    candidates[key] = {'id':row.get('id'), 'text':text, 'scope':scope,
                        'subject':scope['recipient'], 'author':info.get('hermes_author_id'), 'actor':actor,
                        'origin':origin, 'status':info.get('hermes_status') or info['hermes_business_status'],
                        'date':info.get('hermes_business_date'), 'source_ids':info.get('hermes_source_ids') or [row.get('id')],
                        'source':info.get('hermes_source'), 'message_id':info['hermes_business_message_id']}
        words = set(re.findall(r'[\w-]{3,}', query.casefold()))
        def score(row):
            return (len(words & set(re.findall(r'[\w-]{3,}', row['text'].casefold()))), str(row['date']))
        return sorted(candidates.values(), key=score, reverse=True)[:6]
