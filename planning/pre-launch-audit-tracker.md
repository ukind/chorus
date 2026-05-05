# Pre-launch Audit Tracker

**Goal:** ship 99xAgency/chorus to public on GitHub with no embarrassing
launch-day bugs. Audit-only first; fix later.

**Status:** all BLOCKERs shipped (commits `1a3dadd`, `f2983c8`,
`f9e9ae4`, `be30940`). Awaiting final green-light audit (Phase 4)
before flipping the GitHub repo public.

---

## Phase 0 — what's already known + fixed in this session

| | Status |
|---|---|
| Logo + GIF placeholders | ✅ docs/images/README.md committed |
| README rewritten to top-tier OSS shape | ✅ commit `828a85a` |
| CI workflow (typecheck + lint + test + build) | ✅ commit `828a85a` |
| voices auto_missing fix | ✅ commit `a12b76c` |
| Reviewer ## DONE deduplication | ✅ commit `18fbd75` |
| Capture interactive PATH for headless spawns | ✅ commit `72ed0bc` |
| Persist manual CLI paths across daemon restarts | ✅ commit `60aa389` |
| `chorus doctor` diagnostic command | ✅ commit `dded65f` |
| 483 tests passing, typecheck clean | ✅ |

---

## Phase 1 — five-way specialist audit (in flight)

Each audit uses the `review-only-5way` template (5 reviewers: Codex
gpt-5.5, Gemini 3.1 Preview, opencode-go Kimi/DeepSeek/Qwen) with a
narrow brief in the artifact. Findings collated below per audit, then
triaged in Phase 2.

### Audit A — Secrets + .gitignore (Sentinel persona)
- **Chat ID:** `019DF5974FFF984B9DBFC253DCC84533` (4/5 reviewers; gemini quota-exhausted)
- **Findings:**
  - **A1 BLOCKER** `.gitignore` missing `.env.*` (catches `.env.production`, `.env.staging`, etc.) — 4/4 agree
  - **A2 BLOCKER** `~/.chorus/chorus.db` created mode 644 (world-readable) + plaintext API keys in `secrets.value` (`src/lib/db/connection.ts:68`, `src/lib/db/secrets.ts:23`) — 3/4 agree
  - **A3 HIGH** No auth on daemon HTTP API — any local process can read settings, write secrets, fire chats (`src/daemon/index.ts:91`) — 4/4 agree
  - **A4 MEDIUM** No `DELETE /secrets/:provider` endpoint for key rotation
  - **VERIFIED CLEAN** No real committed secrets, telemetry payload matches README

### Audit B — README accuracy vs code (Cartographer persona)
- **Chat ID:** `019DF597893E0DAC24CD10B3FBC8646E` (4/5 reviewers; gemini quota)
- **Findings:**
  - **B1 BLOCKER** README claims "Chorus enforces reviewers come from different model families" but no enforcement — `template-schema.ts:57` has `crossLineage` field but no validator; `templates/review-only.yaml:28+46` has 2 opencode reviewers
  - **B2 HIGH** "Lazy execution" README claim is stale — chats now auto-fire on POST `/chats` (`src/daemon/routes/chats.ts:264`)
  - **B3 HIGH** README architecture deep-dive says "Next.js 15"; `package.json:43` has Next.js 16.2.4
  - **B4 MEDIUM** README mermaid shows `MCP <-->|JSON-RPC| Daemon` — JSON-RPC is the stdio MCP transport only; MCP↔Daemon is REST + SSE (`src/mcp/client.ts:25,73`)
  - **VERIFIED CLEAN** All commands map to register*Command, supported CLI table matches shims, ports 5050/7707 correct

### Audit C — Public API surface stability (Inspector persona)
- **Chat ID:** `019DF597D3F850A5E35384767F2013CB` (4/5 reviewers; gemini quota)
- **Findings:**
  - **C1 HIGH** No `/api/v1` prefix on any REST route — `/health`, `/chats`, `/voices`, `/templates`, `/secrets`, `/onboard/*` all bare. Adding versioning later breaks every consumer — 4/4 agree
  - **C2 HIGH** List endpoints (`/templates`, `/personas`, `/blocked`, `/voices`, `/secrets`) return raw arrays with no `{ items, total, hasMore }` envelope. Pagination is breaking change once shipped — 4/4 agree
  - **C3 HIGH** `chats.attached_files TEXT` JSON-stringified — locks API + DB queryability. Should be a `chat_files` relation
  - **C4 MEDIUM** MCP `template` parameter is `z.string()` with no enum validation; typo silently creates a stuck chat
  - **C5 NOTE** `chats-stream.ts` error responses use `{ error: '...' }` instead of canonical `{ ok: false, error: { code, message } }` envelope

### Audit D — Permissions + safety defaults (Sentinel persona)
- **Chat ID:** `019DF5981831F2FFA89F1C1329FF3E87` (4/5 reviewers; gemini quota)
- **Findings:**
  - **D1 BLOCKER** OpenCode + Kimi shims completely ignore `opts.sandbox` — `Strict` mode is decorative for 40% of reviewers (`src/daemon/agents/opencode.ts:147`, `kimi.ts:167`) — 3/4 agree
  - **D2 BLOCKER** `repoPath` validation accepts symlinks → reading sensitive dirs via `attached_files` (`src/daemon/routes/chats.ts:131-138`). Pure `existsSync` follows symlinks; no `realpath` or `isDirectory` check — 4/4 agree
  - **D3 MEDIUM** `validateCliPath` accepts symlinks; combined with `--version` regex bypass, attacker controlling a `/tmp` dir could persist a Trojan binary path
  - **D4 NOTABLE** `autoApprovePrompts: true` default + workspace sandbox + ignored sandbox in opencode/kimi = doer can shell-out without approval
  - **VERIFIED CLEAN** CORS pinned to `127.0.0.1:5050`, daemon binds 127.0.0.1, `attached_files` has `O_NOFOLLOW` + cwdRoot containment

### Audit E — Missing OSS files + CI correctness (Quartermaster persona)
- **Chat ID:** `019DF59853883292CB9C01E83DC9ECE3` (5/5 reviewers, including gemini)
- **Findings:**
  - **E1 BLOCKER** LICENSE file missing — `package.json` declares Apache-2.0 but no file at repo root; GitHub renders "no license" — 5/5 agree
  - **E2 HIGH** CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md missing
  - **E3 MEDIUM** `.github/ISSUE_TEMPLATE/` + `.github/PULL_REQUEST_TEMPLATE.md` missing
  - **VERIFIED CLEAN** CI workflow correct (pnpm pinned, Node matrix, concurrency, triggers, official actions, all scripts exist), `.gitignore` covers `.next/` `dist/` `node_modules/`

---

## Phase 2 — triage (after audits complete)

For every reported finding, classify:

| Severity | Meaning | Action |
|---|---|---|
| **BLOCKER** | Stops launch | Fix before flipping public |
| **HIGH** | Embarrassing if shipped | Fix before launch ideally; defer-with-issue if time-bound |
| **MEDIUM** | Polish | Backlog |
| **FALSE-POS** | Reviewer hallucinated | Drop |

| # | Audit | Sev | Finding | Action | Status |
|---|---|---|---|---|---|
| 1 | E1 | BLOCKER | LICENSE missing | Add Apache-2.0 LICENSE at repo root | ✅ `1a3dadd` |
| 2 | A1 | BLOCKER | `.gitignore` missing `.env.*` | Add `.env.*` + db sidecars + `~/.chorus` residue | ✅ `1a3dadd` |
| 3 | A2 | BLOCKER | DB world-readable + plaintext secrets | `chmod 700 ~/.chorus`, `chmod 600 chorus.db` at init | ✅ `f2983c8` |
| 4 | D2 | BLOCKER | `repoPath` symlink traversal | `realpathSync` + `statSync` + `isDirectory` checks | ✅ `f2983c8` |
| 5 | D3 | HIGH | `validateCliPath` symlink TOCTOU | lstat + canonical-path persistence (symlinks allowed but resolved) | ✅ `f2983c8` |
| 6 | D1 | BLOCKER | OpenCode/Kimi shims ignore sandbox | Fail-closed via `sandbox-guard.ts` when `sandbox==='strict'` | ✅ `f2983c8` |
| 7 | B1 | BLOCKER | Lineage diversity claim not enforced | Softened README claim to per-template reality | ✅ `f9e9ae4` |
| 8 | B2 | HIGH | README "lazy execution" claim stale | Updated to "auto-fires on POST /chats" | ✅ `f9e9ae4` |
| 9 | B3 | HIGH | README says Next.js 15, code is 16 | Patched architecture deep-dive | ✅ `f9e9ae4` |
| 10 | B4 | MEDIUM | Mermaid diagram MCP arrow | Patched arrow label to REST + SSE | ✅ `f9e9ae4` |
| 11 | E2 | HIGH | CONTRIBUTING/COC/SECURITY missing | Added stub files | ✅ `1a3dadd` |
| 12 | E3 | MEDIUM | Issue + PR templates missing | Added bug.yml + feature.yml + PR template | ✅ `1a3dadd` |
| 13 | A3 | HIGH | No daemon HTTP API auth | Bearer token in `~/.chorus/auth-token` (post-launch — too risky to change wire protocol now) | DEFER |
| 14 | C1 | HIGH | No `/api/v1` versioning prefix | Apply prefix everywhere — DEFER (cockpit lock-step) | DEFER |
| 15 | C2 | HIGH | List endpoints unpaginated | DEFER — same shape risk as C1 | DEFER |
| 16 | C3 | HIGH | `attached_files` JSON column | DEFER — DB migration | DEFER |
| 17 | A4 | MEDIUM | No DELETE /secrets/:provider | Backlog | DEFER |
| 18 | C4 | MEDIUM | MCP `template` not enum-validated | Backlog | DEFER |
| 19 | C5 | LOW | `chats-stream.ts` error envelope | Backlog | DEFER |
| 20 | D4 | NOTE | `autoApprovePrompts: true` default | Document trade-off; revisit post D1 fix | DEFER |

---

## Phase 3 — fix blockers

For each BLOCKER:
1. Single focused commit
2. Targeted `code-review` chat (1 doer + 2 reviewers, both agree)
3. Tick the row above

---

## Phase 4 — final green-light audit

Single review-only chat: *"Are there ANY remaining launch-blockers in
this repo?"* Quorum: unanimous NO → ship. Anything else → back to Phase 3.

---

## Lessons captured along the way

_Append as we go._

- **Daemon spawn PATH ≠ shell PATH** — the most-reproducible launch bug
  for Linux users with custom-install CLIs. Fixed via captured-shell-PATH
  plumbing + manual-path persistence + `chorus doctor` diagnosis.
- **Voices auto_missing** — single transient detection miss used to
  permanently disable a voice. `disabled_reason` column lets re-detect
  restore it.
- **Reviewer SSE 0/5 agreed != failed** — `0/5 agreed` means none
  *approved*; the verdict can still be unanimous `request_changes`.
  Misread once during the 5-way smoke; clarified in summaries.
