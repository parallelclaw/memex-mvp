# memex-openclaw

> [!NOTE]
> **Not maintained.** Use [`memex-mvp`](https://www.npmjs.com/package/memex-mvp) for OpenClaw — its `memex-sync` daemon captures every OpenClaw session via the filesystem layer, no plugin SDK involved.
>
> ```sh
> npm install -g memex-mvp
> memex-sync install   # LaunchAgent on macOS, systemd-user on Linux
> memex-sync scan      # back-fill existing sessions
> ```
>
> Then wire memex into `~/.openclaw/openclaw.json` under `cfg.mcp.servers.memex` so the LLM gets `memex_search` + friends. The [install-memex-claw](https://clawhub.ai/sedelev/install-memex-claw) ClawHub skill automates all of this.

## Why this package exists

An experimental OpenClaw-native plugin path that explored capturing turns via the plugin lifecycle hooks (`agent_end`, `before_compaction`, `session_end`) instead of file-watching. It works — the source is in this directory — but the daemon approach is simpler, doesn't fight the OpenClaw plugin security scanner, doesn't require per-version manifest tuning, and is already production-proven on every OpenClaw deployment.

The code here is preserved for reference. No further releases are planned.

## License

MIT — see `../../LICENSE`.
