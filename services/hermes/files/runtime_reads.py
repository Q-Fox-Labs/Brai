# ABOUTME: Даёт читать штатные runtime outputs без публикации в Artifacts.
# ABOUTME: Закрепляет owner/inode и сохраняет только проверенную копию текущего хода.
"""Readonly runtime sources; these directories are never publication roots."""
import errno
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from .store import FileError, key

# Pinned Hermes producers and their supported legacy locations. Never allow HOME/cache itself.
READ_DIRECTORIES = (
    'cache/spillover', 'cache/terminal-output', 'cache/web', 'web_cache',
    'cache/exec', 'exec_spill', 'cache/delegation', 'delegation_cache',
    'cache/computer_use', 'computer_use_cache', 'hook_outputs',
    'cache/documents', 'document_cache', 'cache/images', 'image_cache',
    'cache/audio', 'audio_cache', 'cache/videos', 'video_cache',
    'cache/screenshots', 'browser_screenshots',
    'cache/vision', 'temp_vision_images', 'cache/video', 'temp_video_files',
    'cache/generated/images', 'cache/generated/videos',
)


def source(path):
    """Return an exact source/root/UID, never a root from a model argument."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        return None
    try:
        from hermes_constants import get_hermes_home
    except ImportError:  # Standalone adapter tests/CLI have no native runtime.
        return None
    home = Path(get_hermes_home())
    for relative in READ_DIRECTORIES:
        root = home / relative
        if path.is_relative_to(root):
            return path, root, os.getuid()
    if os.environ.get('BRAI_IDENTITY_MODE') == 'worker':
        from identity import instructions
        if path.is_relative_to(instructions.ROOT):
            parts = path.relative_to(instructions.ROOT).parts
            if parts and parts[0] == 'current':
                root = instructions.selected_generation()
                return root.joinpath(*parts[1:]), root, 0
            if len(parts) > 2 and parts[0] == '.generations' and re.fullmatch('[0-9a-f]{64}', parts[1]):
                # Old immutable generations remain valid references after a document update.
                instructions.selected_generation()  # Verify the protected namespace first.
                root = instructions.ROOT.joinpath(*parts[:2])
                return path, root, 0
    return None


def _directory(path, uid):
    """Pin directories using traversal permission, including execute-only profile parents."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise FileError('RUNTIME_READ_DENIED')
    flags = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open('/', flags)
    try:
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        info = os.fstat(directory)
        if info.st_uid != uid or info.st_mode & 0o022:
            raise FileError('RUNTIME_READ_DENIED')
        return os.dup(directory)
    finally:
        os.close(directory)


def open_source(root, path, uid):
    """Open a regular, singly linked source without following directory or file links."""
    relative = path.relative_to(root)
    if not relative.parts or '..' in relative.parts:
        raise FileError('RUNTIME_READ_DENIED')
    directory = _directory(root, uid)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid != uid or info.st_mode & 0o022:
                raise FileError('RUNTIME_READ_DENIED')
        fd = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or info.st_mode & 0o022:
            os.close(fd)
            raise FileError('RUNTIME_READ_DENIED')
        return fd
    finally:
        os.close(directory)


def snapshot(selected, workspace):
    """Copy stable bytes, without a publication-size limit or publisher call.

    The content-addressed path is stable across pagination so native read dedup
    keeps working. A changed source gets a new snapshot; cleanup belongs to the turn.
    """
    path, root, uid = selected
    temporary = Path(tempfile.mkdtemp(prefix='.runtime-read-', dir=workspace))
    try:
        digest = hashlib.sha256()
        with os.fdopen(open_source(root, path, uid), 'rb') as stream, (temporary / path.name).open('xb') as output:
            before = os.fstat(stream.fileno())
            size = 0
            while chunk := stream.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            after = os.fstat(stream.fileno())
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            if size != before.st_size or any(getattr(before, f) != getattr(after, f) for f in fields):
                raise FileError('RUNTIME_READ_CHANGED')
            os.fchmod(output.fileno(), 0o400)
        destination = workspace / ('.runtime-read-' + key([str(path), digest.hexdigest()]))
        try:
            temporary.rename(destination)
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
                raise
            # A cached snapshot may not be replaced by a workspace symlink or edited bytes.
            with os.fdopen(open_source(destination, destination / path.name, os.getuid()), 'rb') as existing:
                if hashlib.file_digest(existing, 'sha256').digest() != digest.digest():
                    raise FileError('RUNTIME_READ_CHANGED')
        return str(destination / path.name)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
