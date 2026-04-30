# Install Chorus MCP into Claude Code (or Codex / Cursor) and test it

This is the **dev-mode** install — the npm package isn't published yet, so we
point the orchestrator at the absolute path of `bin/chorus.mjs`.

## Pre-flight (do once on this host)

```bash
cd /home/ubuntu/dev/chorus
pnpm install --prefer-offline
pnpm build:server
cp src/lib/db/schema.sql dist/lib/db/schema.sql   # one-time, until postbuild step lands

# Daemon is already running under PM2 as chorus-daemon:
pm2 list | grep chorus
# If not:
#   pm2 start ecosystem.config.cjs
```

Verify:

```bash
curl -s http://127.0.0.1:7707/health
# {"ok":true,"data":{"ok":true,"version":"0.5.0-dev.0",...}}

curl -s http://127.0.0.1:7707/templates | python3 -c "import json,sys; d=json.load(sys.stdin); print([t['id'] for t in d['data']])"
# ['bug-diagnose', 'code-review', 'red-green', 'architect-review']
```

## Add Chorus to Claude Code's MCP config

Open `~/.claude.json` and add a new entry under `mcpServers`. Two ways to do
it — pick one.

### Option A: edit `~/.claude.json` directly

Find the project block for the directory you'll launch Claude in (e.g.
`/home/ubuntu` or your repo). Add `chorus` to its `mcpServers`:

```json
{
  "projects": {
    "/home/ubuntu": {
      "mcpServers": {
        "chorus": {
          "command": "node",
          "args": ["/home/ubuntu/dev/chorus/bin/chorus.mjs", "mcp"],
          "env": {
            "CHORUS_DAEMON_URL": "http://127.0.0.1:7707"
          }
        }
      }
    }
  }
}
```

### Option B: use Claude's CLI (if you prefer)

```bash
claude mcp add chorus \
  -- node /home/ubuntu/dev/chorus/bin/chorus.mjs mcp
```

Restart Claude Code. The `chorus` MCP server should appear in `/mcp` listing.

## Smoke test from inside Claude Code

In a Claude session, ask:

> Use the chorus MCP server. Call `list_templates` and tell me what's available.

Expected: Claude prints 4 templates — `bug-diagnose`, `code-review`,
`red-green`, `architect-review`.

Then:

> Use `chorus.create_chat` with `work: "Review this for off-by-one errors:
> for (let i = 0; i <= arr.length; i++) { console.log(arr[i]); }"` and
> `template: "code-review"`. Then `chorus.wait_for_chat` on the returned
> chatId.

What happens:
1. `create_chat` returns immediately with a `chatId` and `url`
   (`http://127.0.0.1:3011/runs/<chatId>`).
2. The Chorus daemon spawns a fresh tmux session per reviewer:
   - `chorus-<chatId>-review-reviewer-claude-code-0`
   - `chorus-<chatId>-review-reviewer-codex-cli-1`
   - `chorus-<chatId>-review-reviewer-gemini-2`
3. Each reviewer's CLI launches in `~/.chorus/chats/<chatId>/round-1/...`,
   reads `ask.md`, writes `answer.md`.
4. `wait_for_chat` blocks until consensus or timeout, emitting MCP progress
   notifications on each phase transition.
5. Final response includes verdict + per-reviewer findings.

## Watch what's happening

In a separate terminal:

```bash
# Live tmux sessions Chorus has spawned:
watch -n 1 'tmux ls 2>/dev/null | grep chorus-'

# Live filesystem activity for the chat:
ls -la ~/.chorus/chats/<chatId>/round-1/

# Open the cockpit in a browser:
open http://127.0.0.1:3011                # local
# or: https://chorus.99x.agency             remote (proxied)

# Tail daemon logs:
pm2 logs chorus-daemon --lines 50
```

To attach to a reviewer's tmux pane and see the CLI's view:

```bash
tmux attach -t chorus-<chatId>-review-reviewer-claude-code-0
# Detach with Ctrl-b d
```

## Things that may bite on first run

| Symptom | Why | Fix |
|---|---|---|
| Claude pane stuck at "Trust this folder?" | First launch in fresh chat dir | **Already auto-fixed** — preflight patches `~/.claude.json`. If still stuck, delete the project block in `~/.claude.json` and retry. |
| Codex pane stuck at "Trust this folder?" | Same, for codex | **Already auto-fixed** in `<CODEX_HOME>/config.toml`. If using a brand new account, you'll also need `codex login` once. |
| `wait_for_chat` times out | One reviewer's CLI hung at an interactive prompt | Inspect with `tmux attach -t <session>`; press the right key, or kill the session. The daemon's reaper sweeps idle sessions every 5 min. |
| "Daemon unreachable" from MCP | `chorus-daemon` PM2 process is down | `pm2 restart chorus-daemon` |
| MCP server appears but tools/call hangs | Browser-context limitation we just fixed (proxy in `/api/daemon/`); MCP shouldn't hit this — it talks to daemon directly | Check `pm2 logs chorus-daemon` for the actual call |

## Cancel a misbehaving run

From inside Claude:

> Use `chorus.cancel_chat` with `chatId: "<id>"`.

Or directly:

```bash
curl -X POST http://127.0.0.1:7707/chats/<chatId>/cancel
```

The runner aborts, sessions are killed, `~/.chorus/chats/<chatId>/` stays for
inspection (manually `rm -rf` to clean up).

## After the test — cleanup and report

```bash
# Stop any leftover sessions:
tmux ls 2>/dev/null | grep chorus- | cut -d: -f1 | xargs -r -n1 tmux kill-session -t

# Clear test chats from disk:
rm -rf ~/.chorus/chats/<chatId>

# Or wipe everything if it's a clean test environment:
rm -rf ~/.chorus/chats/* ~/.chorus/chorus.db*
pm2 restart chorus-daemon
```

If you hit a reproducible issue, paste:
1. The MCP call you made
2. The chatId returned
3. `pm2 logs chorus-daemon --lines 100` tail
4. `tmux capture-pane -t <session> -p` of any stuck pane
