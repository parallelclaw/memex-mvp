# install-memex skill

An [Anthropic Skill](https://docs.claude.com/docs/en/agents/skills) that
walks Claude Code (or any MCP-compatible agent that supports the Skills
spec) through installing **memex** on the user's machine — npm install,
MCP-config wiring, auto-capture daemon, and end-to-end verification.

Roughly 2 minutes wall-clock; requires Node.js and shell access.

## Install the skill

```sh
mkdir -p ~/.claude/skills
cp -r /path/to/memex-mvp/skills/install-memex ~/.claude/skills/
```

Or via curl from this repo:
```sh
mkdir -p ~/.claude/skills/install-memex
curl -fsSL https://raw.githubusercontent.com/parallelclaw/memex-mvp/main/skills/install-memex/SKILL.md \
  -o ~/.claude/skills/install-memex/SKILL.md
```

## Use it

In any Skills-aware agent (Claude Code, OpenClaw, …):

```
/install-memex
```

…or just say "install memex" — the skill description is written so
Claude picks it up automatically from natural-language requests.

## What it does (high level)

1. **Discovery** — read-only checks for which MCP client you're using and which AI tool data already lives on this machine.
2. **`npm install -g memex-mvp`** — with EACCES fallbacks (one-shot sudo OR permanent prefix-fix; user picks).
3. **MCP config merge** — single absolute `"command": "<path from which memex>"` entry into your client's mcpServers config. Never overwrites your other servers.
4. **`memex-sync install`** — registers the macOS LaunchAgent for live auto-capture.
5. **`memex-sync scan`** — one-time backfill of every session that already exists on disk.
6. **Verification + restart hint.**

## Why a skill (vs. just copy-pasting the install prompt)

- **`/install-memex`** is shorter than "open the landing, click 'Copy install prompt', paste here"
- Skills are auto-discovered by name — `description` field lets Claude invoke this from any phrasing of "install memex"
- Future updates to the install flow auto-propagate if you re-fetch the skill, instead of relying on the user re-copying

## Related

- 🏠 [memex.parallelclaw.ai](https://memex.parallelclaw.ai) — landing page (also has copy-paste version of this prompt)
- 📦 [memex-mvp on npm](https://www.npmjs.com/package/memex-mvp)
- 📖 [Main memex repo](https://github.com/parallelclaw/memex-mvp)

## License

MIT — see [LICENSE](../../LICENSE) at the repo root.
