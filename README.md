# 🎼 Chorus

> **Get a second opinion on AI-written code — from a different AI.**

You wrote some code with ChatGPT, Claude, or Gemini. It looks good… but the same AI that wrote it can't catch its own blind spots. 🙈

**Chorus** runs your code past 2–3 *other* AIs from *different companies*, in parallel, and tells you whether they agree it's safe to ship.

[![Status](https://img.shields.io/badge/status-v0.7-brightgreen)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)]()

---

## 👀 What it looks like

![Chorus run page showing Claude, Codex, and Gemini reviewing a PR in parallel](docs/images/run-page.png)

Three AIs review the same change. They each give a thumbs up or down. Chorus tells you "✅ Ready to merge" only when they agree.

---

## 🤔 Why bother?

Imagine asking one friend to proofread your essay. They'll catch most typos — but they'll also *miss the same kinds of mistakes you'd miss*, because they think like you.

Now imagine asking **three friends from different backgrounds** to proofread it. Way more bugs caught. 🐛

That's Chorus, but for code.

| Without Chorus 😬 | With Chorus 🎯 |
|---|---|
| One AI writes + reviews its own code | One AI writes, 2 others review |
| Confident but wrong is invisible | Disagreement = red flag |
| You ship, then debug at 2am | Reviewers catch it before merge |

---

## 🚀 Quick start (3 commands)

```bash
npm i -g @chorus-codes/chorus   # 📦 install
chorus init                     # 🔌 auto-connects every AI CLI on your machine
chorus start --ui               # 🎬 boots daemon + opens http://localhost:5050
```

That's it. Open the page, paste some code, hit **Submit**. Watch the AIs argue. ✨

> **Heads up:** Chorus needs at least one AI CLI installed (Claude Code, Codex, Gemini CLI, OpenCode, or Kimi) **or an OpenRouter API key**. `chorus init` checks and warns if none are found. Requires Node ≥ 20.

---

## 🎬 A real example

Let's say you ask Claude to write a divide function:

```js
function divide(a, b) {
  return a / b;
}
```

Looks fine, right? Submit it to Chorus with the **Code Review** template (1 doer + 2 reviewers, both must agree):

1. 🔵 **Claude (writer)** — "Looks correct to me!"
2. 🟡 **Gemini (reviewer)** — "🚨 Missing zero-check. `divide(1, 0)` returns `Infinity`."
3. 🟢 **Codex (reviewer)** — "🚨 Also no type validation — `divide('a', 'b')` returns `NaN`."

**Verdict: ❌ Reject** — both reviewers flagged real bugs. Now you know what to fix *before* you push.

---

## 🛠️ What CLIs are supported?

Chorus auto-detects whichever AI tools you already have installed:

| AI Tool | Can call Chorus | Can act as reviewer | Notes |
|---|---|---|---|
| 🤖 Claude Code | ✅ | ✅ | local CLI |
| 🦾 Codex CLI | ✅ | ✅ | local CLI |
| 💎 Gemini CLI | ✅ | ✅ | local CLI |
| 🌊 OpenCode | ✅ | ✅ | local CLI; routes to Kimi/DeepSeek/etc. |
| 🌙 Kimi CLI | ✅ | ✅ | local CLI |
| 🔌 OpenRouter | — | ✅ | API key, no CLI needed — add voices in Settings |
| ⚡ Cursor | ✅ | — | IDE, not headless |
| 🏄 Windsurf | ✅ | — | IDE, not headless |

You don't need *all* of them. Even **two** different AIs (or one CLI + one OpenRouter voice) is a meaningful improvement over one.

---

## 📝 Built-in templates

Pick one when you submit a chat:

| Template | What it does | Best for |
|---|---|---|
| 🐛 `bug-diagnose` | Claude proposes a hypothesis, Gemini challenges it | "Why is this broken?" |
| 👨‍⚖️ `code-review` | Claude writes; Codex + Gemini review (both must agree) | Pre-merge gate |
| 🏗️ `architect-review` | Cross-vendor critique of design proposals | Big decisions |
| ⚔️ `red-green` | One AI writes tests, *another* writes the code (no peeking) | Adversarial testing |
| 🔍 `review-only` | Paste a diff or draft — three reviewers critique it directly, no doer | Quick external audit |
| 🔺 `tri-review` | Claude doer; Codex + Gemini + Kimi review (2-of-3) | Extra reviewer coverage |

Want your own? Drop a YAML file in `~/.chorus/templates/` and it shows up automatically. You can also assign a different **Persona** to each reviewer slot — so Gemini can wear Sentinel (security) while Codex wears Cartographer (cross-platform), all in the same chat. Built-ins include Sentinel, Cartographer, Accountant, Profiler, Inspector, Quartermaster, Concierge, Conservator, Librarian, Translator.

---

## 🛡️ Permissions & safety

Reviewers can run on your machine. You decide how much trust they get:

- 🔒 **Strict** — read-only. They look, they don't touch.
- 📁 **Workspace** *(default)* — read + write inside the chat folder, no internet.
- 🔓 **Full** — no sandbox. Only on a personal machine you fully trust.

Configure on first run, or anytime at `/settings/permissions`.

---

## 💡 How it actually works (peek under the hood)

```
        ┌─────────────────┐
        │   You submit    │
        │   code + task   │
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │  Chorus daemon  │
        │  (port 7707)    │
        └────────┬────────┘
                 │ spawns each AI as a headless subprocess
       ┌─────────┼─────────┐
       ▼         ▼         ▼
   🤖 Claude  💎 Gemini  🦾 Codex
   (writer)  (reviewer) (reviewer)
       │         │         │
       └─────────┴────┬────┘
                      ▼
              ✅ Verdict + diff
              📊 Cockpit (port 5050)
```

Each AI runs as a separate subprocess. Chorus reads their answers, compares them, and shows you the result live.

---

## 💰 What does it cost?

Chorus runs the CLIs you already have installed — so the cost depends on **how you're paying for those CLIs**:

- **CLI subscriptions** (Claude Pro, ChatGPT Plus, Gemini Advanced — usually $20/mo each): A typical chat is **$0** out of pocket, but counts against your monthly quota.
- **API keys** (pay-per-token): A typical code-review chat (Opus + GPT-5.5 + Gemini Pro) costs roughly **$0.30–$1.50** depending on diff size. Reviewers disagreeing triggers retries — worst case, multiply by 2–3×.

Chorus doesn't add markup. We don't see your tokens. The cockpit shows estimated cost on the run page (heads-up: estimates assume API rates and don't yet detect subscription mode — your real bill may be lower).

---

## 📋 All commands

```bash
chorus init                       # detect + connect every CLI
chorus init --connect claude,gemini   # only specific ones
chorus start [--ui]               # boot daemon (and open browser)
chorus connect <cli>              # wire up one CLI later
chorus ui                         # open the cockpit in browser
chorus status                     # is daemon running?
chorus stop                       # shut it down
chorus mcp                        # run MCP server (CLIs call this)
```

---

## 📡 Telemetry

Chorus pings `chorus.codes` once on daemon boot and once every 24 hours
while running. The payload is small and fixed:

```json
{
  "schema": 1,
  "installId": "<random uuid>",
  "version": "0.7.0",
  "os": "linux", "arch": "x64", "node": "22",
  "daemonUptimeSeconds": 86400,
  "chatsLast24h": 12
}
```

**Never sent:** chat content, prompts, artifacts, file paths, repo paths,
branch names, hostnames, usernames, IPs, API keys, model IDs, voice or
template names. Just the keys above.

**Disable via any one of these:**

```bash
export CHORUS_TELEMETRY=0           # env var (also: false / no / off)
touch ~/.chorus/no-telemetry        # touch-file (cargo/brew convention)
# or set telemetry.enabled=false in cockpit Settings
```

The install ID lives at `~/.chorus/install-id` — `rm` it to mint a fresh
one. Network failures are silent (5s timeout, fire-and-forget) so the
daemon never blocks on the endpoint.

---

## 🔗 Links

- 🌐 Cockpit: <http://localhost:5050>
- 🔌 Daemon API: <http://localhost:7707>
- 🐛 Issues: <https://github.com/99xAgency/chorus/issues>
- 📖 Install guide: [docs/v05/INSTALL-AND-TEST.md](docs/v05/INSTALL-AND-TEST.md)
- 📝 Release notes: [docs/v05/RELEASE-NOTES.md](docs/v05/RELEASE-NOTES.md)

---

## 📜 License

Apache-2.0. See [LICENSE](./LICENSE). Use it however you want — including commercially.

---

*Made with 🎵 by [99x.agency](https://99x.agency). Because one AI just isn't enough.*
