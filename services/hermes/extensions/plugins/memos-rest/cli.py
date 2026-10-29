# ABOUTME: Предоставляет диагностику и явно ограниченное обслуживание MemOS.
# ABOUTME: Область каждой административной команды сверяется с живым профилем.
"""Active-provider CLI: real service health and explicit retry-queue flushing."""


def register_cli(subparser):
    commands = subparser.add_subparsers(dest="memos_command")
    status = commands.add_parser("status", help="Check the MemOS REST service and pending delivery queue")
    status.set_defaults(func=cmd_status)
    flush = commands.add_parser("flush", help="Retry and verify pending MemOS writes")
    flush.add_argument("--timeout", type=float, default=30)
    flush.set_defaults(func=cmd_flush)
    for name in ('prepare', 'freeze', 'resume', 'purge', 'handoff', 'handoff-empty', 'quality-plan', 'quality-apply'):
        admin = commands.add_parser(name, help='Explicit configured profile/owner/managed-cubes memory maintenance')
        profile_choices = {'choices': ['default']} if name in ('purge', 'handoff') else {}
        owner_choices = {'choices': ['root']} if name in ('purge', 'handoff') else {}
        admin.add_argument('--scope-profile', '--profile', dest='profile', required=True, **profile_choices)
        admin.add_argument('--user-id', required=True, **owner_choices)
        admin.add_argument('--managed-cubes', nargs='+', required=True)
        admin.add_argument('--timeout', type=float, default=120)
        if name in ('purge', 'handoff'):
            admin.add_argument('--confirm', required=True)
            admin.add_argument('--new-epoch')
        if name == 'handoff-empty':
            admin.add_argument('--new-epoch', required=True)
        if name == 'quality-apply':
            admin.add_argument('--plan-id', required=True)
            admin.add_argument('--plan-sha', required=True)
        if name == 'quality-plan':
            admin.add_argument('--restore-plan-id', help='Completed historical snapshot to restore before review')
        if name == 'prepare':
            admin.add_argument('--memory-epoch')
            admin.add_argument('--router-url')
            admin.add_argument('--router-model')
            admin.add_argument('--router-env-file')
            admin.add_argument('--router-key-env')
        admin.set_defaults(func=cmd_admin)


def cmd_status(args):
    import json
    from plugins.memory import load_memory_provider
    from hermes_constants import get_hermes_home
    from .client import Client
    from .outbox import Outbox

    provider = load_memory_provider("memos-rest", register_skills=False)
    provider.client = Client(provider.config)
    provider.outbox = Outbox(get_hermes_home(), provider.client)
    print(json.dumps(provider.status(), ensure_ascii=False, indent=2))


def cmd_flush(args):
    import json
    from plugins.memory import load_memory_provider
    from hermes_constants import get_hermes_home

    provider = load_memory_provider("memos-rest", register_skills=False)
    provider.initialize("memos-rest-cli-maintenance", hermes_home=str(get_hermes_home()))
    try:
        complete = provider.outbox.flush(max(1, min(60, args.timeout)))
        print(json.dumps({"complete": complete, **provider.status()}, ensure_ascii=False, indent=2))
    finally:
        provider.shutdown()
    if not complete:
        raise SystemExit(1)


def cmd_admin(args):
    import json
    from hermes_constants import get_hermes_home
    from .admin import Admin
    admin = Admin(get_hermes_home())
    scope = {'profile': args.profile, 'user_id': args.user_id, 'managed_cubes': args.managed_cubes}
    name = args.memos_command
    if name == 'prepare':
        router = dict(admin.config().get('router', {}))
        for key, arg in [('base_url', 'router_url'), ('model', 'router_model'),
                         ('env_file', 'router_env_file'), ('api_key_env', 'router_key_env')]:
            value = getattr(args, arg, None)
            if value is not None:
                router[key] = value
        result = admin.prepare(scope, router, args.memory_epoch)
    elif name == 'quality-plan':
        result = admin.quality_plan(scope, args.restore_plan_id)
    elif name == 'quality-apply':
        result = admin.quality_apply(scope, args.plan_id, args.plan_sha, args.timeout)
    elif name == 'handoff-empty':
        result = admin.handoff_empty(scope, args.new_epoch, args.timeout)
    elif name in ('purge', 'handoff'):
        result = getattr(admin, name)(scope, args.confirm, args.new_epoch, args.timeout)
    elif name == 'freeze':
        result = admin.freeze(scope, args.timeout)
    else:
        result = admin.resume(scope)
    print(json.dumps(result, ensure_ascii=False, indent=2))
