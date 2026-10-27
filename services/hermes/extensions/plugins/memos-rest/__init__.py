"""Hermes MemoryProvider for an existing MemOS REST service."""

from .provider import MemOSProvider


def register(ctx):
    ctx.register_memory_provider(MemOSProvider())
