#!/usr/bin/env python3
# ABOUTME: Проверяет полный batch файлов и применяет его внутри namespace исполнителя.
# ABOUTME: Не выбирает область или writer; отклоняет symlink escapes и защищённые пути.
"""Private file worker; JSON input/output, no shell and no automatic retries."""
import json
import os
from pathlib import Path
import sys

RESERVED = {'.git', 'node_modules', '.env', '.secrets', '.agents', '.codex'}


def checked(root, relative, follow=True):
    """Resolve existing ancestors and reject paths outside the granted root."""
    value = Path(relative)
    if value.is_absolute() or '..' in value.parts or not value.parts:
        raise ValueError('PATH_DENIED')
    if any(p in RESERVED or p.startswith('.env.') for p in value.parts):
        raise ValueError('PATH_DENIED')
    target = root / value
    resolved = target.resolve() if follow else target.parent.resolve() / target.name
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError('PATH_DENIED')
    if any(p in RESERVED or p.startswith('.env.') for p in resolved.relative_to(root).parts):
        raise ValueError('PATH_DENIED')
    return target


def parse_patch(text):
    """Parse Codex apply_patch framing, preserving both sides of moves."""
    lines = text.splitlines()
    if not lines or lines[0] != '*** Begin Patch' or lines[-1] != '*** End Patch':
        raise ValueError('PATCH_INVALID')
    operations, i = [], 1
    while i < len(lines) - 1:
        header = lines[i]
        i += 1
        if header.startswith('*** Add File: '):
            body = []
            while i < len(lines) - 1 and not lines[i].startswith('*** '):
                if not lines[i].startswith('+'):
                    raise ValueError('PATCH_INVALID')
                body.append(lines[i][1:])
                i += 1
            operations.append({'op': 'write', 'path': header[14:], 'content': '\n'.join(body) + '\n', 'create_only': True})
        elif header.startswith('*** Delete File: '):
            operations.append({'op': 'delete', 'path': header[17:]})
        elif header.startswith('*** Update File: '):
            operation = {'op': 'patch', 'path': header[17:], 'hunks': []}
            if i < len(lines) and lines[i].startswith('*** Move to: '):
                operation['to'] = lines[i][13:]
                i += 1
            while i < len(lines) - 1 and not lines[i].startswith('*** '):
                if not lines[i].startswith('@@'):
                    raise ValueError('PATCH_INVALID')
                i += 1
                old, new = [], []
                while i < len(lines) - 1 and not lines[i].startswith(('@@', '*** ')):
                    line = lines[i]
                    if not line or line[0] not in ' +-':
                        raise ValueError('PATCH_INVALID')
                    if line[0] != '+':
                        old.append(line[1:])
                    if line[0] != '-':
                        new.append(line[1:])
                    i += 1
                operation['hunks'].append((old, new))
                if i < len(lines) and lines[i] == '*** End of File':
                    i += 1
            operations.append(operation)
        else:
            raise ValueError('PATCH_INVALID')
    if not operations:
        raise ValueError('PATCH_INVALID')
    return operations


def apply_hunks(content, hunks):
    """Require exact, unambiguous hunk context before any file is changed."""
    lines = content.splitlines()
    offset = 0
    for old, new in hunks:
        matches = [i for i in range(offset, len(lines) - len(old) + 1) if lines[i:i + len(old)] == old]
        if len(matches) != 1:
            raise ValueError('PATCH_CONTEXT_MISMATCH')
        start = matches[0]
        lines[start:start + len(old)] = new
        offset = start + len(new)
    return '\n'.join(lines) + '\n'


def run(request):
    """Preflight every source/destination and content, then execute without rerouting."""
    if request['action'] == 'parse':
        return {'operations': parse_patch(request['patch'])}
    root = Path(request['root']).resolve(strict=True)
    if request['action'] == 'read':
        target = checked(root, request['path'])
        if target.stat().st_size > 1024 * 1024:
            raise ValueError('OUTPUT_LIMIT')
        return {'content': target.read_text()}
    operations = request['operations']
    plan, targets = [], set()
    for op in operations:
        target = checked(root, op['path'], follow=op['op'] not in ('delete', 'rename', 'symlink'))
        paths = [target]
        destination = None
        if 'to' in op:
            destination = checked(root, op['to'], follow=False)
            paths.append(destination)
        if op['op'] == 'rename' and destination is None:
            raise ValueError('DESTINATION_REQUIRED')
        if any(str(p) in targets for p in paths):
            raise ValueError('BATCH_OVERLAP')
        targets.update(map(str, paths))
        if op['op'] in ('write', 'patch'):
            if target.exists() and not target.is_file():
                raise ValueError('FILE_REQUIRED')
            content = op.get('content')
            if op['op'] == 'patch':
                content = apply_hunks(target.read_text(), op['hunks'])
            if not isinstance(content, str):
                raise ValueError('CONTENT_REQUIRED')
            if op.get('create_only') and target.exists():
                raise ValueError('PATH_EXISTS')
        else:
            content = None
        if op['op'] in ('delete', 'rename') and not (target.exists() or target.is_symlink()):
            raise ValueError('PATH_MISSING')
        if op['op'] in ('delete', 'rename') and target.is_dir() and not target.is_symlink():
            raise ValueError('FILE_REQUIRED')
        if destination is not None and (destination.exists() or destination.is_symlink()):
            raise ValueError('PATH_EXISTS')
        if op['op'] == 'symlink':
            if target.exists() or target.is_symlink():
                raise ValueError('PATH_EXISTS')
            link = op['target']
            if Path(link).is_absolute():
                raise ValueError('PATH_DENIED')
            resolved = (target.parent / link).resolve()
            if not resolved.is_relative_to(root):
                raise ValueError('PATH_DENIED')
            checked(root, str(resolved.relative_to(root)))
        if op['op'] not in ('write', 'patch', 'delete', 'rename', 'symlink'):
            raise ValueError('OPERATION_INVALID')
        plan.append((op, target, destination, content))
    if request.get('check_only'):
        return {'validated': True}
    for op, target, destination, content in plan:
        if op['op'] in ('write', 'patch'):
            output = destination or target
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content)
            if destination:
                target.unlink()
        elif op['op'] == 'delete':
            target.unlink()
        elif op['op'] == 'rename':
            destination.parent.mkdir(parents=True, exist_ok=True)
            target.rename(destination)
        elif op['op'] == 'symlink':
            target.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(op['target'], target)
    return {'changed': len(plan)}


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except (ValueError, KeyError, OSError):
        print(json.dumps({'error': 'FILE_OPERATION_REJECTED'}))
        sys.exit(1)
