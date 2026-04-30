# Chorus

> Driver-agnostic multi-LLM peer review for code decisions.

You write code with your favourite AI CLI (Claude Code, Codex, Gemini,
OpenCode, Kimi, Cursor, Windsurf). Chorus spawns 2–4 _other_ LLMs from
different vendors to independently review the work, then surfaces the
verdict before you ship.

Why: the same model that wrote the code can't catch its own blind spots.
Bring a different lineage in and you get a real second opinion — without
context-switching out of your editor.

**Status:** v0.5 — pre-release. Apache-2.0.

## Quick start

```bash
npm i -g chorus
chorus init     # detects installed CLIs, registers the chorus MCP server in each
chorus start    # boots the local daemon + cockpit on http://localhost:5050
```

That's it. Open the cockpit, fire a chat, watch the reviewers stream their
critiques back live.

If you'd rather invoke from inside a CLI:

- **Claude Code**: `/chorus bug-diagnose <paste your snippet>`
- **Codex / Gemini / Kimi / OpenCode / Cursor / Windsurf**: just say
  *"chorus, run code-review on…"* — the MCP server we registered routes it.

## What gets connected

`chorus init` detects each CLI's config dir and wires Chorus as an MCP
server. No prompts to dismiss in the CLI for the ones that support
config-file pre-approval (Claude, Gemini, OpenCode). Kimi, Cursor, and
Windsurf show a one-time "Always allow" prompt the first time you call a
chorus tool — click through once and it's quiet forever.

| CLI | Inbound (call chorus from inside) | Outbound (chorus uses as reviewer) |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Codex | ✅ | ✅ |
| Gemini | ✅ | ✅ |
| OpenCode | ✅ | ✅ |
| Kimi | ✅ | ✅ |
| Cursor | ✅ | — (IDE, not headless) |
| Windsurf | ✅ | — (IDE, not headless) |

## Templates

Built-in templates ship with the package:

- `bug-diagnose` — adversarial diagnosis (Claude Opus + Gemini cross-check)
- `code-review` — 3-of-4 quorum across 4 lineages
- `architect-review` — design proposal vs. cross-lineage devil's advocates
- `red-green` — adversarial test/impl split with information asymmetry

You can also drop your own under `~/.chorus/templates/<id>.yaml`.

## Permissions

Cockpit `/settings/permissions` controls what reviewers can do:

- **Strict** — read only
- **Workspace** (default) — read+write inside the chat dir
- **Full** — no sandbox, only on a personal machine you trust

Plus toggles for auto-approving in-CLI prompts and outbound network access.

## Commands

```
chorus init               # detect + connect every supported CLI
chorus init --connect <list>  # only the ones you list (claude,codex,...)
chorus start [--ui]       # start daemon + open cockpit
chorus connect <cli>      # post-install one-CLI wire-up
chorus ui                 # open cockpit in browser
chorus status             # daemon health
chorus stop               # stop daemon
chorus mcp                # run MCP server on stdio (orchestrators call this)
```

## Project links

- Cockpit: <http://localhost:5050>
- Daemon API: <http://localhost:7707>
- Issues / discussion: <https://github.com/99xAgency/chorus>

## License

Apache-2.0. See [LICENSE](./LICENSE).
