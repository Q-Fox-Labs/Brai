#!/usr/bin/env python3
"""Scoped stdlib client for the locally installed MemOS product API."""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


def build_request(a):
    scope = {'user_id': a.user}
    if a.command == 'health':
        return '/health', None
    if a.command == 'status':
        return '/product/scheduler/status?' + urllib.parse.urlencode(scope), None
    if a.command == 'search':
        return '/product/search', dict(scope, readable_cube_ids=[a.cube], query=a.query,
            mode='fast', top_k=a.top_k, relativity=0, rerank=False, dedup='no',
            include_preference=False, search_tool_memory=False, include_skill_memory=False,
            internet_search=False, chat_history=[])
    if a.command == 'list':
        return '/product/get_memory', dict(scope, mem_cube_id=a.cube, page=a.page,
            page_size=a.page_size, include_preference=True, include_tool_memory=True,
            include_skill_memory=True)
    if a.command == 'get':
        # Scoped retrieval rather than unscoped GET /get_memory/{id}.
        return '/product/get_memory', dict(scope, mem_cube_id=a.cube,
            filter={'id': a.id}, include_preference=True, include_tool_memory=True,
            include_skill_memory=True)
    if a.command == 'add':
        return '/product/add', dict(scope, writable_cube_ids=[a.cube],
            async_mode='sync', mode='fast', session_id=a.session,
            messages=[{'role': 'user', 'content': a.text}], chat_history=[],
            custom_tags=['hermes'], info=json.loads(a.info))
    if a.command == 'feedback':
        return '/product/feedback', dict(scope, writable_cube_ids=[a.cube],
            session_id=a.session, async_mode='sync', history=[],
            feedback_content=a.text, retrieved_memory_ids=a.id,
            corrected_answer=False)
    if a.command == 'delete':
        if not a.confirm_delete:
            raise ValueError('Deletion requires --confirm-delete and explicit memory IDs')
        return '/product/delete_memory', {'writable_cube_ids': [a.cube],
            'memory_ids': a.id, 'auto_cleanup_working': False}
    raise ValueError('Unsupported command')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base-url', default='http://127.0.0.1:8001')
    p.add_argument('--user', default='root')
    p.add_argument('--cube', default='main')
    p.add_argument('--timeout', type=float, default=240)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('health')
    sub.add_parser('status')
    s = sub.add_parser('search')
    s.add_argument('--query', required=True)
    s.add_argument('--top-k', type=int, default=5)
    s = sub.add_parser('list')
    s.add_argument('--page', type=int, default=1)
    s.add_argument('--page-size', type=int, default=20)
    s = sub.add_parser('get')
    s.add_argument('--id', required=True)
    s = sub.add_parser('add')
    s.add_argument('--text', required=True)
    s.add_argument('--session', required=True)
    s.add_argument('--info', default='{"source_type":"hermes"}')
    s = sub.add_parser('feedback')
    s.add_argument('--text', required=True)
    s.add_argument('--id', action='append', required=True)
    s.add_argument('--session', required=True)
    s = sub.add_parser('delete')
    s.add_argument('--id', action='append', required=True)
    s.add_argument('--confirm-delete', action='store_true')
    a = p.parse_args()
    try:
        path, payload = build_request(a)
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        req = urllib.request.Request(a.base_url.rstrip('/') + path, data=body,
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=a.timeout) as r:
            result = json.load(r)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if isinstance(result, dict) and result.get('code', 200) != 200:
            return 1
        return 0
    except (ValueError, OSError, urllib.error.URLError) as e:
        # Do not print request payloads or credentials in error output.
        print(json.dumps({'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
