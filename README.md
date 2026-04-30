# 🎼 Chorus

> **Get a second opinion on AI-written code — from a different AI.**

You wrote some code with ChatGPT, Claude, or Gemini. It looks good… but the same AI that wrote it can't catch its own blind spots. 🙈

**Chorus** runs your code past 2–4 *other* AIs from *different companies*, in parallel, and tells you whether they agree it's safe to ship.

[![Status](https://img.shields.io/badge/status-v0.5_pre--release-orange)]()
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)]()

---

## 👀 What it looks like

![Chorus run page showing Claude, Codex, and Gemini reviewing a PR in parallel](docs/images/run-page.png)

Three AIs review the same pull request. They each give a thumbs up or down. Chorus tells you "✅ Ready to merge" only when they agree.

---

## 🤔 Why bother?

Imagine asking one friend to proofread your essay. They'll catch most typos — but they'll also *miss the same kinds of mistakes you'd miss*, because they think like you.

Now imagine asking **four friends from different backgrounds** to proofread it. Way more bugs caught. 🐛

That's Chorus, but for code.

| Without Chorus 😬 | With Chorus 🎯 |
|---|---|
| One AI writes + reviews its own code | One AI writes, 3 others review |
| Confident but wrong is invisible | Disagreement = red flag |
| You ship, then debug at 2am | Reviewers catch it before merge |

---

## 🚀 Quick start (3 commands)

```bash
npm i -g chorus      # 📦 install
chorus init          # 🔌 auto-connects every AI CLI on your machine
chorus start         # 🎬 opens http://localhost:5050
```

That's it. Open the page, paste some code, hit **Submit**. Watch four AIs argue. ✨

---

## 🎬 A real example

Let's say you ask Claude to write a divide function:

```js
function divide(a, b) {
  return a / b;
}
```

Looks fine, right? Submit it to Chorus with the **Bug Diagnose** template:

1. 🔵 **Claude (writer)** — "Looks correct to me!"
2. 🟡 **Gemini (reviewer)** — "🚨 Missing zero-check. `divide(1, 0)` returns `Infinity`."
3. 🟢 **Codex (reviewer)** — "🚨 Also no type validation — `divide('a', 'b')` returns `NaN`."

**Verdict: ❌ Reject.** Now you know what to fix *before* you push.

---

## 🛠️ What CLIs are supported?

Chorus auto-detects whichever AI tools you already have installed:

| AI Tool | Can call Chorus | Can act as reviewer |
|---|---|---|
| 🤖 Claude Code | ✅ | ✅ |
| 🦾 Codex CLI | ✅ | ✅ |
| 💎 Gemini CLI | ✅ | ✅ |
| 🌊 OpenCode | ✅ | ✅ |
| 🌙 Kimi CLI | ✅ | ✅ |
| ⚡ Cursor | ✅ | — *(IDE, not headless)* |
| 🏄 Windsurf | ✅ | — *(IDE, not headless)* |

You don't need *all* of them. Even **two** different AIs is a meaningful improvement over one.

---

## 📝 Built-in templates

Pick one when you submit a chat:

| Template | What it does | Best for |
|---|---|---|
| 🐛 `bug-diagnose` | One AI hunts the bug, another double-checks | "Why is this broken?" |
| 👨‍⚖️ `code-review` | 4 AIs review, 3-of-4 must agree | Pre-merge gate |
| 🏗️ `architect-review` | Cross-vendor critique of design proposals | Big decisions |
| ⚔️ `red-green` | One AI writes tests, *another* writes the code (no peeking) | Adversarial testing |

Want your own? Drop a YAML file in `~/.chorus/templates/` and it shows up automatically.

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
                 │ spawns each AI in its own tmux session
       ┌─────────┼─────────┬──────────┐
       ▼         ▼         ▼          ▼
   🤖 Claude  💎 Gemini  🦾 Codex  🌙 Kimi
   (writer)  (reviewer) (reviewer) (reviewer)
       │         │         │          │
       └─────────┴────┬────┴──────────┘
                      ▼
              ✅ Verdict + diff
              📊 Cockpit (port 5050)
```

Each AI runs in a separate sandboxed terminal. Chorus reads their answers, compares them, and shows you the result live.

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
