# ABOUTME: Доставляет проверенные факты и ищет их в разрешённых кубах памяти.
# ABOUTME: Переписка хранится отдельно от фактов; автор и область проверяются локально.
"""Profile-local multi-cube worker. Durable jobs pin extraction before delivery."""
import json
from concurrent.futures import ThreadPoolExecutor
import math
import re
from collections import Counter
from pathlib import Path

from .client import Client, MemOSError, fact_fields, memory_text, internal_dialogue
from .router import Catalog, SemanticRouter, stable_id, QUALITY_VERSION, evidence_context


class RecallRows(list):
    """Передать выдачу и полноту поиска вместе, без общего изменяемого статуса."""

    def __init__(self, rows=(), *, scanned=0, needs_sources=False, source_query='', archive_searched=False,
                 needs_topic=False):
        super().__init__(rows)
        self.scanned = scanned
        self.needs_sources = needs_sources
        self.source_query = source_query
        self.archive_searched = archive_searched
        self.needs_topic = needs_topic


def lexical_order(query, rows):
    """Упорядочить полный набор по BM25; не исключать кандидатов по словам."""
    def tokens(text):
        return re.findall(r'[\w]+', text.casefold().replace('ё', 'е'))
    terms = set(tokens(query))
    documents = [Counter(tokens(memory_text(row))) for row in rows]
    lengths = [sum(doc.values()) for doc in documents]
    average = sum(lengths) / max(1, len(lengths)) or 1
    frequency = {term: sum(term in doc for doc in documents) for term in terms}
    def score(index):
        doc, length = documents[index], lengths[index]
        return sum(math.log(1 + (len(rows) - frequency[t] + .5) / (frequency[t] + .5))
            * doc[t] * 2.2 / (doc[t] + 1.2 * (.25 + .75 * length / average))
            for t in terms if doc[t])
    return [rows[i] for i in sorted(range(len(rows)), key=score, reverse=True)]


class RoutedRuntime:
    def __init__(self, provider):
        self.provider = provider
        self.home = Path(provider.home)
        self.api = provider.client
        self.catalog = Catalog(self.home)
        self.router = SemanticRouter(provider.config.get('router', {}), self.catalog)
        self.router.document_metadata = getattr(provider, 'document_metadata', None)
        self.epoch = provider.config['memory_epoch']
        self.generation = provider.config.get('generation', 1)
        self.home_scope = stable_id(str(self.home.resolve()))

    def reload(self):
        try:
            config = json.loads((self.home / 'memos-rest.json').read_text())
        except (OSError, ValueError):
            raise MemOSError('Memory configuration unavailable; writes suspended') from None
        if not config.get('routing_enabled') or not config.get('memory_epoch') or config.get('deployment_phase') not in ('setup', 'production'):
            raise MemOSError('Multi-cube configuration requires phase and epoch')
        if config.get('deployment_phase') == 'production':
            from .admin import json_file
            state = json_file(self.home / 'memos-rest' / 'admin-state.json')
            if state.get('status') != 'complete' or state.get('phase') != 'production' or state.get('new_epoch') != config['memory_epoch']:
                raise MemOSError('Production requires a completed scoped handoff')
        self.catalog = Catalog(self.home)
        self.router.catalog = self.catalog
        self.router.config = dict(config.get('router', {}))
        return config

    def writable(self, job=None):
        config = self.reload()
        if not config.get('enabled', True) or config.get('frozen', False) or config.get('suspended', False):
            raise MemOSError('Memory writes suspended/frozen')
        if config['memory_epoch'] != self.epoch or config.get('generation', 1) != self.generation:
            raise MemOSError('Old session memory epoch is fenced')
        if job and (job.get('epoch') != config['memory_epoch'] or job.get('generation') != config.get('generation', 1)):
            raise MemOSError('Stale memory job is fenced')
        sid = ((job or {}).get('body') or {}).get('session_id') or self.provider.session_id
        self.check_session(sid, config)
        return config

    def check_session(self, sid, config):
        from .admin import json_file
        fence = json_file(self.home / 'memos-rest' / 'session-fence.json')
        key = stable_id(str(sid))
        if key in fence.get('revoked', []) or fence.get('sessions', {}).get(key, config['memory_epoch']) != config['memory_epoch']:
            raise MemOSError('Pre-handoff session replay is fenced')
        db = self.home / 'state.db'
        if fence.get('cutoff') and db.exists():
            import sqlite3
            from contextlib import closing
            try:
                with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as conn:
                    row = conn.execute('SELECT started_at FROM sessions WHERE id = ?', (sid,)).fetchone()
                if row and (row[0] is None or float(row[0]) <= float(fence['cutoff'])):
                    raise MemOSError('Canonical pre-handoff session is fenced')
            except sqlite3.Error:
                raise MemOSError('Canonical session fence unavailable; writes suspended') from None

    def register_job(self, job):
        # Called under Outbox submit.lock, shared with administrative maintenance.
        from .admin import json_file
        from utils import atomic_json_write
        config = self.writable(job)
        sid = (job.get('body') or {}).get('session_id') or self.provider.session_id
        path = self.home / 'memos-rest' / 'session-fence.json'
        fence = json_file(path)
        fence.setdefault('sessions', {})[stable_id(str(sid))] = config['memory_epoch']
        atomic_json_write(path, fence, mode=0o600, fsync_dir=True)

    def admin(self):
        from .admin import Admin
        return Admin(self.home, self.api)

    def client(self, cube, job=None):
        if cube not in self.catalog.cubes:
            raise MemOSError('Unmanaged cube')
        scoped = Client({**self.provider.config, 'cube_id': cube})
        # Guard the actual mutation, including recovery GET -> ADD races.
        def request(path, body=None, **kwargs):
            if path in ('/product/add', '/product/delete_memory'):
                self.writable(job)
            return self.api.request(path, body, **kwargs)
        scoped.request = request
        return scoped

    def enqueue(self, job):
        config = self.writable()
        info = job['body']['info']
        info.update(hermes_memory_epoch=config['memory_epoch'], hermes_deployment_phase=config['deployment_phase'],
                    hermes_subject_id=info.get('hermes_subject_id', info['hermes_author_id']), hermes_classification='pending',
                    hermes_logical_id=info['hermes_event_id'], hermes_memberships=['main'], hermes_cube='main')
        info['hermes_payload_hash'] = stable_id({k: v for k, v in info.items() if k != 'hermes_payload_hash'})
        job.update(epoch=config['memory_epoch'], generation=config.get('generation', 1), operation='route',
                   project=self.catalog.project(self.provider.context.get('gateway_session_key', ''),
                                                self.provider.context.get('project')))
        return job

    def _deliver(self, cube, unit, job, checkpoint):
        self.writable(job)
        return self.client(cube, job).execute(unit, lambda value: checkpoint(job))

    def conversation_context(self, job):
        """Восстановить назначение из реплик того же автора в той же сессии.

        Контекст не становится источником цитат нового факта. Сохраняются
        начальные цели и последние уточнения, без доступа к чужим сообщениям.
        """
        body = job['body']
        rows = self.scoped_rows('main', {'session_id': body['session_id']}, body['info']['hermes_author_id'])
        seen, context = set(), []
        for row in rows:
            info = row['metadata']['info']
            event = info.get('hermes_event_id')
            if info.get('hermes_kind') not in ('turn', 'explicit', 'native') or event in seen:
                continue
            seen.add(event)
            context.extend(m['content'] if m.get('role') == 'user'
                           else '[assistant historical source]\n' + m['content']
                           for m in info.get('hermes_messages', []) if m.get('role') in ('user', 'assistant'))
        if not context:
            context = [m['content'] for m in body['messages'] if m.get('role') == 'user']
        return evidence_context(context, [{'text': m['content'], 'source': {'quote': m['content']}}
                                         for m in body['messages']])

    def execute(self, job, checkpoint):
        self.writable(job)
        if job.get('operation') == 'scoped_delete':
            ids = []
            for cube in self.catalog.cubes:
                self.writable(job)
                rows = self.scoped_rows(cube, job['filter'], job['author_id'])
                self.client(cube).delete([r['id'] for r in rows])
                ids.extend(r['id'] for r in rows)
            return sorted(set(ids))
        if job.get('operation') == 'forget':
            ids = []
            for cube in self.catalog.cubes:
                self.writable(job)
                rows = self.scoped_rows(cube, {'hermes_logical_id': job['logical_id']}, job['author_id'])
                selected = [row['id'] for row in rows]
                self.client(cube).delete(selected)
                ids.extend(selected)
            return sorted(set(ids))
        if job.get('operation') != 'route':
            raise MemOSError('Unsupported multi-cube operation')
        if job.get('delete_filter') and 'native_old_logical_ids' not in job:
            old = [r for c in self.catalog.cubes for r in self.scoped_rows(c, job['delete_filter'], job['body']['info']['hermes_author_id'])]
            job['native_old_logical_ids'] = sorted({r['metadata']['info']['hermes_logical_id'] for r in old
                                                  if r['metadata']['info'].get('hermes_kind') == 'fact'})
            if len(job['native_old_logical_ids']) == 1:
                job['replacement_id'] = job['native_old_logical_ids'][0]
            checkpoint(job)
        if 'archive' not in job:
            job['archive'] = {'body': job['body']}
            checkpoint(job)
        archive_ids = self._deliver('main', job['archive'], job, checkpoint)
        if 'facts' in job and job.get('quality_version') != QUALITY_VERSION:
            # AIDEV-NOTE: Сохранённый старым worker план не должен занести мусор
            # после обновления. Старые частичные копии удаляются только после нового read-back.
            job['stale_quality'] = True
            job.pop('facts'); job.pop('units', None)
            checkpoint(job)
        if 'facts' not in job:
            from .provider import scrub
            # A checkpoint contains several speakers. It is a recovery archive,
            # never a source of facts attributed to a synthetic session owner.
            info = job['body']['info']
            unresolved = info.get('hermes_author_id') in (None, '', 'unknown', 'multiple_or_unknown')
            facts = [] if info.get('hermes_kind') == 'checkpoint' or unresolved else scrub(
                self.router.extract(job['body']['messages'], job.get('project'), self.conversation_context(job)))
            if job.get('replacement_id') and len(facts) != 1:
                raise MemOSError('A logical correction must produce exactly one grounded fact')
            if job.get('shared_infra') and (not facts or any('infra' not in f['memberships'] for f in facts)):
                raise MemOSError('Shared infrastructure requires grounded infra membership')
            job['facts'] = facts
            job['classification'] = 'classified'
            job['quality_version'] = QUALITY_VERSION
            checkpoint(job)
        ids = list(archive_ids)
        units = job.setdefault('units', {})
        for fact in job['facts']:
            if job.get('shared_infra') and 'infra' not in fact['memberships']:
                raise MemOSError('Shared infrastructure requires grounded infra membership')
            # IDs are source-anchored, not random model wording or retry order.
            logical_id = job.get('replacement_id') or stable_id([job['event_id'], fact['source'], fact['text'], fact['status']])
            for cube in fact['memberships']:
                key = logical_id + ':' + cube
                if key not in units:
                    info = {**job['body']['info'], 'hermes_kind': 'fact', 'hermes_classification': 'classified',
                            'hermes_logical_id': logical_id, 'hermes_event_id': stable_id([logical_id, cube, job['event_id'], QUALITY_VERSION]),
                            'hermes_source_event': job['event_id'], 'hermes_source_ids': archive_ids,
                            'hermes_quality_version': QUALITY_VERSION, **fact_fields(fact['text']),
                            'hermes_source': fact['source'], 'hermes_status': fact['status'],
                            'hermes_spheres': fact['spheres'], 'hermes_projects': fact['projects'],
                            'hermes_memberships': fact['memberships'], 'hermes_primary_cube': fact['memberships'][0],
                            'hermes_cube': cube, 'hermes_messages': [{'role': fact['source']['role'], 'content': fact['source']['quote']}]}
                    info['hermes_shared_infra'] = bool(job.get('shared_infra') and cube == 'infra')
                    if info['hermes_shared_infra']:
                        info['hermes_messages'] = [{'role': fact['source']['role'], 'content': fact['source']['quote']}]
                        info['hermes_context'] = {}  # Sharing a fact does not share private chat/session context.
                    info['hermes_payload_hash'] = stable_id({k: v for k, v in info.items() if k != 'hermes_payload_hash'})
                    units[key] = {'body': {'session_id': job['body']['session_id'],
                                         'messages': [{'role': 'user', 'content': fact['text']}], 'info': info}}
                    checkpoint(job)
                ids.extend(self._deliver(cube, units[key], job, checkpoint))
        if job.get('stale_quality'):
            author = job['body']['info']['hermes_author_id']
            for cube in self.catalog.cubes:
                self.writable(job)
                rows = self.scoped_rows(cube, {'hermes_source_event': job['event_id']}, author)
                self.client(cube).delete([r['id'] for r in rows
                    if r['metadata']['info'].get('hermes_kind') == 'fact' and r['id'] not in ids])
        if job.get('replacement_id'):
            author = job['body']['info']['hermes_author_id']
            for cube in self.catalog.cubes:
                self.writable(job)
                rows = self.scoped_rows(cube, {'hermes_logical_id': job['replacement_id']}, author)
                self.client(cube).delete([r['id'] for r in rows if r['id'] not in ids])
        if job.get('delete_filter'):
            for cube in self.catalog.cubes:
                self.writable(job)
                rows = self.scoped_rows(cube, job['delete_filter'], job['body']['info']['hermes_author_id'])
                self.client(cube).delete([r['id'] for r in rows if r['id'] not in ids])
        return sorted(set(ids))

    def delete_job(self, filter_):
        config = self.writable()
        return {'operation': 'scoped_delete', 'filter': filter_, 'author_id': self.provider.author['id'],
                'epoch': config['memory_epoch'], 'generation': config.get('generation', 1)}

    def allowed(self, row, config, author=None):
        meta = row.get('metadata') or {}
        info = meta.get('info') or {}
        if info.get('hermes_visibility') == 'business_private' or info.get('hermes_business_scope') is not None:
            return False
        cube = row.get('_cube_id')
        shared = (author is None and self.catalog.data.get('shared_infra') is True and cube == 'infra'
                  and info.get('hermes_shared_infra') is True)
        return (meta.get('user_id') == config['user_id'] and cube in self.catalog.cubes
                and info.get('hermes_cube') == cube and cube in info.get('hermes_memberships', [])
                and info.get('hermes_home_scope') == self.home_scope
                and info.get('hermes_memory_epoch') == config['memory_epoch']
                and (info.get('hermes_author_id') == (author or self.provider.author['id']) or shared))

    def scoped_rows(self, cube, filter_, author=None):
        config = self.reload()
        return [r for r in self.client(cube).get(filter_) if self.allowed(r, config, author)]

    def read(self, identifier):
        self.reload()
        for filter_ in ({'id': identifier}, {'hermes_logical_id': identifier}):
            with ThreadPoolExecutor(max_workers=4) as executor:
                pools = executor.map(lambda cube: self.scoped_rows(cube, filter_), self.catalog.cubes)
                for rows in pools:
                    if rows:
                        return self.decorate(rows[0])
        return None

    def decorate(self, row):
        info = row['metadata']['info']
        if info.get('hermes_classification') == 'pending':
            receipt = self.provider.outbox.receipt(info['hermes_event_id'])
            row['_classification'] = ('classified' if receipt.get('fact_count') else 'unclassified') if receipt else 'pending/unclassified'
        return row

    def search(self, query, sid, top_k=None, project=None, cubes=None, include_archive=False, all_cubes=False,
               *, expand_sources=False, context=None):
        """Проверить всю разрешённую область и отобрать свидетельства по вопросу.

        Кубы задают явную область, но автоматическая классификация не закрывает
        остальные знания. BM25 только упорядочивает кандидатов; смысловой
        проверяющий решает, относятся ли они к вопросу, и может вернуть ноль.
        """
        config = self.reload()
        if not config.get('enabled', True) or config.get('suspended', False):
            return RecallRows()
        project = self.catalog.project(self.provider.context.get('gateway_session_key', ''), project)
        if cubes is not None:
            if not isinstance(cubes, list) or any(c not in self.catalog.cubes for c in cubes):
                raise ValueError('Recall cubes are not catalogued')
        selected = self.catalog.cubes if all_cubes or cubes is None else cubes
        plan = self.router.plan(query, context) if expand_sources else None
        if plan:
            query = plan['query']
            if plan['goal'] == 'needs_topic':
                return RecallRows(needs_topic=True, source_query=query)
        candidates, source_dates = {}, {}
        def collect(cube):
            return self.client(cube).get({})
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(selected)))) as executor:
            pools = list(executor.map(collect, selected))
        for pool in pools:
            for row in pool:
                if not self.allowed(row, config):
                    continue
                info = row['metadata']['info']
                if info.get('hermes_kind') in ('turn', 'native') and internal_dialogue(info.get('hermes_messages')):
                    continue
                if info.get('hermes_kind') in ('turn', 'explicit', 'native'):
                    source_dates[info.get('hermes_event_id')] = row['metadata'].get('created_at')
                if info.get('hermes_kind') == 'checkpoint':
                    continue
                if info.get('hermes_kind') != 'fact' and not (include_archive or expand_sources):
                    continue
                if project and project not in info.get('hermes_projects', []):
                    continue
                decorated = self.decorate(row)
                if info.get('hermes_kind') == 'fact':
                    key = info.get('hermes_logical_id') or row['id']
                else:
                    key = 'source:' + str(info.get('hermes_event_id') or row['id'])
                    # У исходника остаётся физический ID, полный диалог читается
                    # memos_read(include_transcript=true), без потери частей.
                    dialogue = info.get('hermes_messages') or []
                    if dialogue:
                        decorated = {**decorated, 'memory': '\n\n'.join(
                            str(m.get('role', 'source')) + ': ' + str(m.get('content', '')) for m in dialogue)}
                if key not in candidates:
                    candidates[key] = decorated
        ordered = lexical_order(query, [{**row, '_source_date': (source_dates.get(
            row['metadata']['info'].get('hermes_source_event'))
            if row['metadata']['info'].get('hermes_kind') == 'fact' else row['metadata'].get('created_at'))}
            for row in candidates.values()])
        def select(pool):
            candidates = [{'text': memory_text(row),
                'kind': row['metadata']['info'].get('hermes_kind'),
                'status': row['metadata']['info'].get('hermes_status'),
                'date': row.get('_source_date')} for row in pool]
            result = self.router.rank(query, candidates, **({'goal': plan['goal']} if plan else {}))
            rows = [{**pool[m['index']], '_relevance': m['relevance'],
                     '_relevance_reason': m['reason'],
                     '_document_metadata': m.get('document_metadata', [])} for m in result['matches']]
            return rows, result
        document_lookup = bool(plan and plan['goal'] == 'locate_document')
        initial = ([row for row in ordered if row['metadata']['info'].get('hermes_kind') == 'fact']
                   if expand_sources and not include_archive and not document_lookup else ordered)
        rows, result = select(initial)
        scanned, archive_searched = len(initial), include_archive or document_lookup
        if expand_sources and not archive_searched and (not rows or result['needs_sources']):
            archive = [row for row in ordered if row['metadata']['info'].get('hermes_kind') != 'fact']
            # AIDEV-NOTE: Исходники уже прочитаны с той же проверкой доступа.
            # Не перечитываем 15 кубов и не проверяем те же факты второй раз.
            source_rows, source_result = select(archive)
            rows.extend(source_rows)
            scanned += len(archive)
            archive_searched = True
            result = {**source_result, 'needs_sources': result['needs_sources'] or source_result['needs_sources']}
        rows.sort(key=lambda row: row['_relevance'] != 'direct')
        return RecallRows(rows[:top_k], scanned=scanned, needs_sources=result['needs_sources'],
                          source_query=result['source_query'], archive_searched=archive_searched)

    def forget(self, identifier):
        config = self.writable()
        row = self.read(identifier)
        logical_id = row['metadata']['info']['hermes_logical_id'] if row else identifier
        event_id = stable_id(['forget', self.home_scope, config['memory_epoch'], self.provider.author['id'], logical_id])
        if self.provider.outbox.receipt(event_id):
            return {'status': 'deleted', 'logical_id': logical_id, 'event_id': event_id}
        if not row:
            return {'status': 'not_found'}
        if row['metadata']['info']['hermes_author_id'] != self.provider.author['id']:
            raise ValueError('Shared memory is read-only for other authors')
        job = {'operation': 'forget', 'logical_id': logical_id, 'author_id': self.provider.author['id'],
               'epoch': config['memory_epoch'], 'generation': config.get('generation', 1)}
        self.provider.outbox.submit(event_id, job)
        verified = self.provider.outbox.flush(float(self.provider.config['tool_write_timeout']), event_id)
        return {'status': 'deleted' if verified else 'pending', 'logical_id': logical_id, 'event_id': event_id}

    def remember(self, content, sid, project=None, operation_id=None, shared_infra=False):
        import uuid
        config = self.writable()
        if type(shared_infra) is not bool or (shared_infra and self.catalog.data.get('shared_infra') is not True):
            raise ValueError('Shared infrastructure must be explicitly enabled in the catalog')
        project = self.catalog.project(self.provider.context.get('gateway_session_key', ''),
                                       project or self.provider.context.get('project'))
        event_id = stable_id(['remember', self.home_scope, config['memory_epoch'], self.provider.author['id'],
                             operation_id or uuid.uuid4().hex])
        rows = [{'role': 'user', 'content': content}]
        job = self.enqueue({'body': self.provider._body(rows, sid, 'explicit', self.provider.author, event_id)})
        job['project'] = project
        job['shared_infra'] = shared_infra
        job['request_hash'] = stable_id([content, project, shared_infra])
        self.provider.outbox.submit(event_id, job)
        verified = self.provider.outbox.flush(float(self.provider.config['tool_write_timeout']), event_id)
        self.provider._cache.clear()
        return {'status': 'verified' if verified else 'pending', 'event_id': event_id,
                'memory_ids': (self.provider.outbox.receipt(event_id) or {}).get('memory_ids', [])}

    def replace(self, identifier, content, sid, operation_id=None):
        config = self.writable()
        identity = ['replace', self.home_scope, config['memory_epoch'], self.provider.author['id'],
                    operation_id or [identifier, content]]
        event_id = stable_id(identity)
        receipt = self.provider.outbox.receipt(event_id)
        if receipt:
            if receipt.get('request_hash') != stable_id([identifier, content]):
                raise MemOSError('Memory operation ID conflicts with its original payload')
            return {'status': 'verified', 'event_id': event_id, 'memory_ids': receipt['memory_ids']}
        row = self.read(identifier)
        if row is None:
            return {'status': 'not_found'}
        if row['metadata']['info']['hermes_author_id'] != self.provider.author['id']:
            raise ValueError('Shared memory is read-only for other authors')
        logical_id = row['metadata']['info']['hermes_logical_id']
        rows = [{'role': 'user', 'content': content}]
        job = self.enqueue({'body': self.provider._body(rows, sid, 'correction', self.provider.author, event_id)})
        job['replacement_id'] = logical_id
        job['request_hash'] = stable_id([identifier, content])
        self.provider.outbox.submit(event_id, job)
        verified = self.provider.outbox.flush(float(self.provider.config['tool_write_timeout']), event_id)
        return {'status': 'verified' if verified else 'pending', 'event_id': event_id, 'logical_id': logical_id,
                'memory_ids': (self.provider.outbox.receipt(event_id) or {}).get('memory_ids', [])}

