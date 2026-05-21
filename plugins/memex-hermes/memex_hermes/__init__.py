"""memex-hermes: verbatim local-first memory provider for Hermes Agent.

After `pip install memex-hermes`, Hermes' plugin discovery finds the
entry point declared in pyproject.toml:

    [project.entry-points."hermes_agent.plugins"]
    memex = "memex_hermes"

…imports this module, and calls `register(ctx)` below. We hand Hermes a
MemexMemoryProvider instance via the registry callback. From that point
the provider is active for every session.

Users opt in by setting `memory.provider: "memex"` in ~/.hermes/config.yaml
(via `hermes memory setup memex` or by hand). Built-in MEMORY.md remains
active in parallel — memex captures everything additionally as verbatim
archive.
"""

from __future__ import annotations

import logging
from typing import Any

from memex_hermes.provider import MemexMemoryProvider

__version__ = "0.1.3"
__all__ = ["MemexMemoryProvider", "register", "__version__"]

log = logging.getLogger(__name__)


def register(ctx: Any) -> None:
    """Hermes plugin entry point.

    Called once at startup by Hermes' plugin loader. `ctx` is a registry
    proxy that exposes `register_memory_provider(instance)`. We instantiate
    MemexMemoryProvider and hand it over.

    All errors here are fatal (Hermes will report plugin load failure),
    so we let exceptions propagate rather than swallow them — a misconfigured
    plugin should be visible at startup, not silently disabled.
    """
    provider = MemexMemoryProvider()
    ctx.register_memory_provider(provider)
    log.info("memex-hermes registered (version=%s)", __version__)
