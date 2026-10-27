"""Keep Codex's built-in search available to the Hermes tool loop."""

from .provider import CodexCLIWebSearchProvider


def register(ctx):
    ctx.register_web_search_provider(CodexCLIWebSearchProvider())
