#!/usr/bin/env python3
# ABOUTME: Поддерживает надстройку hermescustom и её проверки.
# ABOUTME: Реализует поведение пакета для профиля Hermes.
"""Fetch a pinned extension with ephemeral read credentials; preserve existing checkouts."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit


def validate_repository(repository, allow_local=False):
    url = urlsplit(repository)
    if allow_local and not url.scheme and Path(repository).is_absolute():
        return
    if url.scheme != 'https' or url.hostname != 'github.com' or url.username or url.password or url.port or url.query or url.fragment:
        raise ValueError('Use a credential-free HTTPS GitHub repository URL')
    if not re.fullmatch(r'/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', url.path):
        raise ValueError('Invalid GitHub repository path')


def authenticated_env(token_file, temporary):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    # Never inherit verbose transport logging that could expose headers.
    for name in list(env):
        if name.startswith(('GIT_TRACE', 'GIT_CURL_VERBOSE')):
            env.pop(name)
    if token_file:
        token = Path(token_file)
        mode = token.stat()
        if not stat.S_ISREG(mode.st_mode) or token.is_symlink() or mode.st_uid != os.geteuid() or mode.st_mode & 0o077:
            raise ValueError('Read token must be a regular owner-only file owned by the invoking user')
        if not token.read_text().strip():
            raise ValueError('Read token is empty')
        askpass = Path(temporary) / 'askpass'
        askpass.write_text("#!/usr/bin/python3\nimport os,sys\nfrom pathlib import Path\nprint('x-access-token' if 'username' in sys.argv[1].lower() else Path(os.environ['HERMESCUSTOM_READ_TOKEN_FILE']).read_text().strip())\n")
        askpass.chmod(0o700)
        env['GIT_ASKPASS'] = str(askpass)
        env['HERMESCUSTOM_READ_TOKEN_FILE'] = str(token.resolve())
    return env


def run_git(directory, arguments, env):
    result = subprocess.run(['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
                             '-c', 'core.fsmonitor=false', *arguments], cwd=directory,
                            env=env, text=True, capture_output=True, timeout=180)
    if result.returncode:
        # Transport output is not a safe place to report credentials or URLs.
        raise ValueError('Git operation failed: ' + arguments[0] + ' (exit ' + str(result.returncode) + ')')
    return result.stdout.strip()


def clone(repository, directory, revision, token_file=None, allow_local=False):
    validate_repository(repository, allow_local)
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('A full immutable Git commit is required')
    root = Path(directory)
    if root.is_symlink():
        raise ValueError('Extension checkout must be a real directory')
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hermescustom-auth-') as temporary:
        # Existing checkouts require no network or credentials on an identical repeat.
        local_env = authenticated_env(None, temporary)
        initialized = (root / '.git').exists()
        if initialized:
            if run_git(root, ['rev-parse', '--show-toplevel'], local_env) != str(root.resolve()):
                raise ValueError('Not an independent repository')
            if run_git(root, ['remote', 'get-url', 'origin'], local_env) != repository:
                raise ValueError('Existing extension has a different origin')
            head = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=root,
                                  env=local_env, text=True, capture_output=True)
            if head.returncode == 0:
                if head.stdout.strip() != revision:
                    raise ValueError('Existing revision differs; use the separate reviewed update workflow')
                if run_git(root, ['status', '--porcelain'], local_env):
                    raise ValueError('Existing extension has local changes; refusing to overwrite')
                return False
            if run_git(root, ['status', '--porcelain'], local_env):
                raise ValueError('Interrupted checkout has local files; refusing to overwrite')
        elif any(root.iterdir()):
            raise ValueError('Extension directory is not empty; refusing to overwrite')
        env = authenticated_env(token_file, temporary)
        if not initialized:
            run_git(root, ['init', '--initial-branch=main'], env)
            run_git(root, ['remote', 'add', 'origin', repository], env)
        run_git(root, ['fetch', '--depth=1', 'origin', revision], env)
        run_git(root, ['checkout', '-B', 'main', 'FETCH_HEAD'], env)
        if run_git(root, ['rev-parse', 'HEAD'], env) != revision:
            raise ValueError('Fetched extension does not match the pinned commit')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository')
    parser.add_argument('directory')
    parser.add_argument('revision')
    parser.add_argument('--token-file')
    parser.add_argument('--allow-local', action='store_true', help='Only for isolated local fixtures')
    args = parser.parse_args()
    changed = clone(args.repository, args.directory, args.revision, args.token_file, args.allow_local)
    print(json.dumps({'changed': changed}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
