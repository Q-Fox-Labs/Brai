# ABOUTME: Подключает общую файловую границу к штатному pinned движку экземпляра Hermes.
# ABOUTME: Сохраняет native permissions и проверку прежних overlays; не запускает gateway.
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import tempfile

PIN = '517b5e10febd619ce30bb22580e29b160266eb43'


def require(value, code):
    """Остановить установку при неизвестном состоянии без раскрытия private inputs."""
    if not value:
        raise RuntimeError(code)


def atomic(path, content, uid, gid, mode):
    """Атомарно записать только точный операторский файл с защищёнными permissions."""
    path = Path(path)
    require(path.is_absolute() and not path.is_symlink(), 'UNSAFE_INSTALL_PATH')
    if path.exists() and path.read_bytes() == content:
        info = path.stat()
        require(info.st_uid == uid and info.st_gid == gid and info.st_mode & 0o777 == mode, 'FILES_METADATA_DRIFT')
        return False
    fd, temporary = tempfile.mkstemp(prefix='.brai-files-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def patch_paths(patch):
    """Принимать только относительные имена существующих исходников внутри движка."""
    paths = re.findall(r'^--- a/(.+)$', Path(patch).read_text(), re.M)
    require(paths and all(not Path(p).is_absolute() and '..' not in Path(p).parts for p in paths), 'FILES_PATCH_PATH_REJECTED')
    return paths


def baseline_hashes(engine, patch):
    """Проверить прежние native overlays на копии с обратным применением нашего delta."""
    engine, patch = Path(engine), Path(patch)
    paths = patch_paths(patch)
    command = ['/usr/bin/git', '-c', 'safe.directory=' + str(engine), '-C', str(engine)]
    if subprocess.run([*command, 'apply', '--reverse', '--check', str(patch)], capture_output=True).returncode:
        return {}
    with tempfile.TemporaryDirectory(prefix='hermes-files-baseline-') as temporary:
        staging = Path(temporary)
        for name in paths:
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(engine / name, target)
        subprocess.run(['/usr/bin/git', 'apply', '--reverse', str(patch)], cwd=staging, check=True, capture_output=True)
        return {name: sha256((staging / name).read_bytes()).hexdigest() for name in paths}


def configuration_plan(engine, profile, runtime, config_path, tools_path, owner_name, owner_id, account,
                       node, sealed_engine, publisher, identity):
    """Составить точные файлы и права до изменения выбранного экземпляра."""
    state, work, cache = profile / 'brai-files', profile / 'brai-files/work', Path(publisher['resultRoot'])
    extra = [work, profile / 'media/downloads', profile / 'images', profile / 'cache/generated/images',
             *[profile / 'cache' / name for name in ('audio', 'documents', 'images', 'screenshots', 'videos')],
             profile / 'usercustom/userdata/projects', profile / 'usercustom/userdata/files']
    publisher = dict(publisher)
    roots = list(dict.fromkeys([*publisher['allowedReadRoots'], *map(str, extra)]))
    files = runtime / 'services/hermes/files'
    publisher_path = Path(json.loads(tools_path.read_text())['publisher']['configPath'])
    config = {'ownerId': owner_id, 'runtimeUser': owner_name, 'account': account, 'stateRoot': str(state), 'resultRoot': str(cache),
              'moduleRoot': str(files), 'engineRoot': str(engine), 'toolsConfig': str(tools_path), 'node': str(node),
              'entry': str(runtime / 'services/hermes/trusted.mjs'), 'readRoots': roots,
              'legacyRoots': [str(profile / 'usercustom/userdata/projects'), str(profile / 'usercustom/userdata/files'), str(profile / 'workspace')],
              'temporaryRoots': [str(work), str(cache), str(profile / 'media/downloads'), str(profile / 'images'),
                  *[str(profile / 'cache' / name) for name in ('audio', 'documents', 'images', 'screenshots', 'videos')],
                  str(profile / 'cache/generated/images')],
              'serviceRoots': [str(engine), str(runtime), str(profile / 'docs'), str(profile / 'config.yaml'), str(profile / '.env'),
                  str(profile / 'skills'), str(profile / 'prompts'), str(profile / 'scripts'),
                  str(profile / 'usercustom/hermescustom'), str(profile / 'usercustom/userdata/instructions'),
                  str(profile / 'usercustom/userdata/skills')]}
    encode = lambda value: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    publisher['allowedReadRoots'] = roots
    bootstrap_uid, bootstrap_mode = (0, 0o440) if sealed_engine else (identity.pw_uid, 0o644)
    plan = [(engine / 'brai_files.py', (files / 'bootstrap.py').read_text().replace(repr('__BRAI_FILES_CONFIG__'), repr(str(config_path))).encode(), bootstrap_uid, identity.pw_gid, bootstrap_mode),
            (config_path, encode(config), 0, identity.pw_gid, 0o640),
            (publisher_path, encode(publisher), publisher_path.stat().st_uid, publisher_path.stat().st_gid, publisher_path.stat().st_mode & 0o777)]
    return plan


def install(engine, profile, runtime, config_path, tools_path, owner_name, owner_id, account, check=False, *,
            node='/opt/node-v24.22.1-linux-x64/bin/node', sealed_engine=False):
    """Подготовить обязательный адаптер на отдельном движке данного экземпляра."""
    engine, profile, runtime, config_path, tools_path = map(Path, (engine, profile, runtime, config_path, tools_path))
    require(all(p.is_absolute() and p.resolve() == p for p in (engine, profile, runtime, config_path, tools_path)), 'FILES_PATH_REJECTED')
    require(Path(node).is_absolute() and Path(node).resolve() == Path(node), 'FILES_NODE_PATH_REJECTED')
    require(type(sealed_engine) is bool, 'FILES_ENGINE_MODE_REJECTED')
    config_parent = config_path.parent.stat()
    require(config_parent.st_uid == 0 and not config_parent.st_mode & 0o022, 'FILES_INSTANCE_CONFIG_REJECTED')
    identity = pwd.getpwnam(owner_name)
    tools = json.loads(tools_path.read_text())
    publisher_path = Path(tools['publisher']['configPath'])
    require(publisher_path.is_absolute() and publisher_path.resolve() == publisher_path, 'FILES_PUBLISHER_PATH_REJECTED')
    publisher = json.loads(publisher_path.read_text())
    require(owner_id and tools['ownerId'] == owner_id == publisher['ownerId'], 'FILES_OWNER_MISMATCH')
    state, work, cache = profile / 'brai-files', profile / 'brai-files/work', Path(publisher['resultRoot'])
    extra = [work, profile / 'media/downloads', profile / 'images', profile / 'cache/generated/images',
             *[profile / 'cache' / name for name in ('audio', 'documents', 'images', 'screenshots', 'videos')],
             profile / 'usercustom/userdata/projects', profile / 'usercustom/userdata/files']
    roots = list(dict.fromkeys([*publisher['allowedReadRoots'], *map(str, extra)]))
    for path in (state, work, cache, *extra):
        if check:
            require(path.is_dir() and path.resolve() == path, 'FILES_DIRECTORY_MISSING')
        else:
            missing, parent = [], path
            while not parent.exists():
                require(parent.is_relative_to(profile), 'FILES_DIRECTORY_OUTSIDE_PROFILE')
                missing.append(parent)
                parent = parent.parent
            for directory in reversed(missing):
                directory.mkdir(mode=0o700)
                os.chown(directory, identity.pw_uid, identity.pw_gid)
            require(path.is_dir() and path.resolve() == path, 'FILES_DIRECTORY_UNSAFE')
    files, changed = runtime / 'services/hermes/files', False
    patch = files / 'native.patch'
    git = ['/usr/bin/git', '-c', 'safe.directory=' + str(engine), '-C', str(engine)]
    require(subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip() == PIN, 'FILES_ENGINE_PIN_MISMATCH')
    applied = bool(baseline_hashes(engine, patch))
    if not applied:
        require(not check, 'FILES_ENGINE_PATCH_MISSING')
        require(subprocess.run([*git, 'apply', '--check', str(patch)], capture_output=True).returncode == 0,
                'FILES_ENGINE_PATCH_CONFLICT')
        metadata = {}
        for name in patch_paths(patch):
            path = engine / name
            info = path.stat()
            try:
                acl = os.getxattr(path, 'system.posix_acl_access')
            except OSError as error:
                import errno
                if error.errno not in (errno.ENODATA, errno.ENOTSUP):
                    raise
                acl = None
            metadata[name] = (info.st_uid, info.st_gid, info.st_mode & 0o777, acl)
        subprocess.run([*git, 'apply', str(patch)], check=True, capture_output=True)
        for name, (uid, gid, mode, acl) in metadata.items():
            path = engine / name
            os.chown(path, uid, gid)
            os.chmod(path, mode)
            if acl is not None:
                os.setxattr(path, 'system.posix_acl_access', acl)
        changed = True
    plan = configuration_plan(engine, profile, runtime, config_path, tools_path, owner_name, owner_id,
                              account, node, sealed_engine, publisher, identity)
    for path, content, uid, gid, mode in plan:
        if check:
            require(not path.is_symlink() and path.is_file() and path.read_bytes() == content, 'FILES_INSTALL_DRIFT')
            info = path.stat()
            require(info.st_uid == uid and info.st_gid == gid and info.st_mode & 0o777 == mode, 'FILES_METADATA_DRIFT')
        else:
            changed = atomic(path, content, uid, gid, mode) or changed
    return {'changed': changed, 'enginePin': PIN, 'patchSha256': sha256(patch.read_bytes()).hexdigest()}


def main():
    """Параметры задаёт Ansible; owner из сообщения или модели не принимается."""
    parser = argparse.ArgumentParser()
    for name in ('engine', 'profile', 'runtime', 'config', 'tools', 'owner', 'owner-id', 'account'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'FILES_INSTALL_REQUIRES_OPERATOR')
    print(json.dumps(install(args.engine, args.profile, args.runtime, args.config, args.tools, args.owner, args.owner_id, args.account, args.check)))


if __name__ == '__main__':
    main()
