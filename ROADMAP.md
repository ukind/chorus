# Chorus Roadmap

> Living plan for what's shipping. Owns the cross-version product story so nothing gets lost during repo migrations or version cuts.

---

## Core product insight

Chorus's depth comes from a three-axis combinatorial:

```
Voices  ×  Personas  ×  Phases
```

- **Voices** — the model behind the keyboard. CLI subscriptions (Claude Code, Codex, Gemini, OpenCode, Kimi) and API-routed models (anything reachable via OpenRouter, Anthropic API, etc.). Each voice has a lineage tag (anthropic / openai / google / moonshot / deepseek / meta / mistral / xai).
- **Personas** — the *role* a reviewer plays. A system prompt + worldview. Same model produces wildly different output as Sentinel (security) vs Cartographer (cross-platform) vs Accountant (cost).
- **Phases** — the position in the pipeline. Discover, Define, Develop, Deliver, Debate, Decide. User can add, remove, reorder.

A **template** is a chosen path through this 3D space — N phases, each with a (voice, persona) pair. Different combinations produce wildly different outcomes. Users will experiment to find what works for their domain (Rails refactor, React perf, Solidity audit, copy review, …) and share what wins.

This is the seed of the **template marketplace**: an asset class that didn't exist before chorus.

---

## Status tracker

| Item | Version | Status | Notes |
|---|---|---|---|
| Audit fixes 1-7 (dogfood pre-publish) | 0.6 | ✅ DONE | shipped 2026-05-01 |
| Cross-platform CLI detection (`where` + fallback dirs + `--version` verify) | 0.6 | ✅ DONE | |
| Manual CLI path entry UI | 0.6 | ✅ DONE | |
| Persona registry — table + 10 built-ins + seed loader | 0.7 | ✅ DONE | |
| MCP `list_personas` + `invoke_persona` | 0.7 | ✅ DONE | 9 MCP tools total |
| Voices abstraction (table + auto-populate from CLIs) | 0.7 | 📐 PLANNED | |
| OpenRouter inline flow (validate → fetch models → multi-add) | 0.7 | 📐 PLANNED | |
| Phase composition UI (drag/reorder, edit prompts) | 0.7 | 📐 PLANNED | |
| Default chorus-on-chorus template (Sentinel + Cartographer + Accountant + Translator) | 0.7 | 📐 PLANNED | bakes meta-fix |
| Squashed migration push to `chorus-codes/chorus` | 0.7 | ⏳ NEXT | piece-by-piece audit using personas |
| `npm publish @chorus-codes/chorus` | 0.7 | ⏳ NEXT | rotate token after first publish |
| Cleanup `99xAgency/chorus-ship-e2e` sandbox repo | 0.7 | ⏳ TODO | |
| Home dashboard (CLI status, usage, reset windows, cost) | 0.8 | 📐 PLANNED | |
| Run history + cost aggregates | 0.8 | 📐 PLANNED | |
| Template marketplace (Stripe + revenue share) | 0.9 | 📐 PLANNED | |
| Local LLM voices (Ollama, llama.cpp) | 1.0+ | 💭 IDEA | |
| CI integration (`chorus review --pr 1234`) | 1.0+ | 💭 IDEA | |

Legend: ✅ done · ⏳ in flight · 📐 designed · 💭 idea

---

## v0.6 — Public launch (DONE 2026-05-01)

Shipped:
- Audit-fix sweep — 7 real bugs caught dogfooding pre-publish (build asset copy, fresh-DB migration, MCP id↔chatId, CLI auto-detect, chorus start in dist, web spawn, postinstall hint)
- Cross-platform CLI detection — `where` on Windows + `which` on Unix, 8 fallback install dirs per OS, `--version` smoke test
- Manual path entry — when auto-detect misses, user pastes the path to the binary and chorus validates
- Reset → reinstall verified end-to-end via `npm pack` + `npm install -g <tarball>`
- Postinstall hint UX with state-aware help banner

---

## v0.7 — Voices · Personas · Phases (CURRENT)

The big one. Cracks the marketplace open.

### 1. Personas (DONE)

**Storage:** `personas` table seeded from `prompts/personas/*.md` on daemon startup. Built-in rows refresh from file source-of-truth on every boot; user-cloned rows (`builtin = 0`) are never overwritten.

**Built-in library** (full prompts in [`prompts/personas/`](prompts/personas/)):

| Persona | One-liner | Recommended lineage |
|---|---|---|
| **Sentinel** | Hunts secrets, injection, broken auth, supply-chain risk | anthropic |
| **Conservator** | Spots when a change fights the existing pattern instead of joining it | openai |
| **Cartographer** | Catches Windows/macOS/Linux assumptions, path separators, line endings, encoding | google |
| **Profiler** | N+1 queries, big-O cliffs, cold-path costs, latency budgets | openai |
| **Translator** | Reviews labels, errors, empty states, help text — for layman users, not engineers | anthropic |
| **Accountant** | Asks "who pays for this, when, and is there bill shock?" | anthropic |
| **Concierge** | Time-to-first-success — install path, error legibility, docs alignment | anthropic |
| **Quartermaster** | Scrutinizes every new dep — maintenance, license, transitive footprint, install scripts | openai |
| **Inspector** | Identifies what's not tested but should be — and what's tested but worthless | openai |
| **Librarian** | Reads README, marketing copy, help text alongside the diff and flags every lie | anthropic |

Each prompt is a *worldview*, not a checklist — single role, list of red flags to actively hunt, and an out-of-scope guard so personas don't bleed into each other's lanes.

**MCP surface** (live now):

- `list_personas()` → `{ personas: [{id, label, oneLiner, recommendedLineage, builtin}] }`
- `invoke_persona({personaId, brief, repoPath?, files?, template?})` → `{chatId, status, url}` — fires a real chat with the persona's system_prompt prepended to the user's brief.

### 2. Voices (PLANNED)

**Goal:** unify CLI subs and API-routed models into one routable abstraction the template designer can target.

**Storage:** new `voices` table.

```sql
CREATE TABLE voices (
  id TEXT PRIMARY KEY,            -- "claude-code" or "openrouter:moonshotai/kimi-k2"
  label TEXT NOT NULL,
  source TEXT NOT NULL,           -- "cli" | "api"
  provider TEXT NOT NULL,         -- "claude-code" | "openrouter" | "anthropic" | ...
  model_id TEXT,                  -- API: actual model id; CLI: NULL
  lineage TEXT NOT NULL,          -- "anthropic" | "openai" | "google" | "moonshot" | ...
  input_cost_per_mtok REAL,       -- $ per 1M input tokens (NULL for flat-rate CLI subs)
  output_cost_per_mtok REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

Auto-populated from CLI auto-detect on first run. Lineage tagged for diversity scoring in the template designer ("you have anthropic + openai — consider adding moonshot or deepseek for spread").

### 3. OpenRouter inline (PLANNED — ships with Voices)

**UX flow** on the OpenRouter row in onboarding/Settings:

```
┌─ OpenRouter ─────────────────────────────────┐
│ [sk-or-...........]  [Validate & list models] │
│ ✓ Validated. 327 models available.            │
│                                               │
│   Pick which to enable as voices:             │
│   ☐ Search models…                            │
│                                               │
│   Anthropic                                   │
│     ☐ claude-opus-4   $15/$75 per 1M          │
│   Moonshot                                    │
│     ☑ kimi-k2          $0.27/$1.10 per 1M     │
│   DeepSeek                                    │
│     ☑ deepseek-v3      $0.14/$0.28 per 1M     │
│   Meta                                        │
│     ☐ llama-3.1-405b   $0.80/$0.80 per 1M     │
│                                               │
│   2 selected. Save & add as voices.           │
└───────────────────────────────────────────────┘
```

**Mechanics:**

- New endpoint `POST /providers/openrouter/validate` body `{key}`:
  - Calls `GET https://openrouter.ai/api/v1/models` with `Authorization: Bearer <key>`
  - On 200 → returns model list (id, lineage, context, input_cost, output_cost)
  - On 401 → `{ok: false, error: "Invalid OpenRouter key"}`
  - On network fail → graceful timeout error
- Frontend caches the model list for the session (no re-fetch per re-render).
- User selects N models. On Save:
  - Upsert secret `openrouter` with the key
  - Insert N rows into `voices` table
- Voices table becomes the canonical source for the template designer's voice picker. CLI subs auto-populate the same table on first detect.

**Lineage tagging** — each OpenRouter model belongs to a lineage (anthropic / openai / google / meta / moonshot / deepseek / mistral / xai). Critical for chorus's diversity story.

**Cost surfacing** — per-1M-token costs shown in picker. Template designer later shows "this template will cost ~$X per run" (sum of expected tokens × per-model cost). Avoids the bill-shock failure mode.

### 4. Phase composition (PLANNED)

Templates become editable sequences:

```
phase {
  position: 0,
  phase_kind: "review",  // doer | review | synthesis | decide
  voice_id: "openrouter:moonshotai/kimi-k2",
  persona_id: "cartographer",
  prompt_overrides: { ... }   // overrides on top of persona system_prompt
}
```

UI: drag-to-reorder, add/remove phases, fork from existing template. Token inserts in prompts: `{{user_brief}}`, `{{prior_phase_outputs}}`, `{{repo_diff}}`, `{{file_path}}`.

### 5. Default chorus-on-chorus template (PLANNED)

Hard-codes Sentinel + Cartographer + Accountant + Translator as the four reviewer slots in chorus's own audit template. The next person reviewing chorus *can't* skip those four lenses — bakes the meta-lessons into the product.

### 6. Migration to chorus-codes (NEXT)

After v0.7 ships:

1. Piece-by-piece audit via MCP — fire personas against critical files (`src/cli/index.ts`, `src/daemon/runner.ts`, etc.) using real chorus chats. The audit is the dogfood demo.
2. Findings → cleanup branch → squashed push to `chorus-codes/chorus` (single clean snapshot, no 99xAgency history).
3. Update `package.json` `name` → `@chorus-codes/chorus`, repository + bugs URLs.
4. `npm publish --access public`. Rotate token after first publish.
5. Cleanup `99xAgency/chorus-ship-e2e` sandbox repo.

---

## v0.8 — Home dashboard (PLANNED)

A live overview of your model fleet. Answers "what do I have, what am I burning, when do my limits reset."

**Scope:**
- **CLI status panel** — per CLI: installed/healthy, version, last-used, recent error count
- **Usage & reset windows** — for each subscription:
  - Tokens consumed this period
  - Period reset time (Claude Pro 5h windows, Codex daily caps, Gemini quotas)
  - Visualised as filling-bar with countdown
- **Cost tracking** — per-run, per-template, per-day:
  - CLI sub usage shown in "shadow $" (list-price equivalent for capacity planning)
  - API usage shown in real $
  - Aggregate dashboard with breakdown by voice, by template, by phase
- **Health pings** — heartbeat per CLI every N minutes, surfaces "claude is unhealthy" before a run fails
- **Run history** — last 50 chats with status, voices used, total cost, duration

**Storage:** new tables `voice_usage`, `cost_event`, `cli_health_ping`.

**Effort:** ~1 week.

---

## v0.9 — Template Marketplace (PLANNED)

Foundations for shareable / sellable templates.

- Public `chorus.codes/templates` directory
- Author profiles, install count, ratings, tags
- One-click install: `chorus template install <slug>`
- Free tier: open templates, anyone can share
- Premium tier: gated templates, Stripe integration, revenue share with author
- Signing & verification (templates are config + prompts, but supply chain still matters)

**Effort:** ~3 weeks (auth + payments + moderation).

---

## v1.0+ — Future (IDEAS)

- **Custom phase types** — users can define new phase kinds beyond review/doer/synthesis
- **Conditional phases** — "only run Sentinel if repo has API endpoints"
- **Multi-repo templates** — review changes across a monorepo or set of services
- **CI integration** — `chorus review --pr 1234` runs your template against any GitHub PR
- **Local LLM voices** — Ollama, llama.cpp as voices (offline / private)

---

## Website plan

`chorus.codes` needs a **Templates** section to sell the v0.7+ story:

1. **Hero update** — replace generic "multi-LLM peer review" with "Voices × Personas × Phases. Build your own. Or use one that wins."
2. **Templates page** (`/templates`) — gallery view:
   - Featured templates (curated): "React Refactor", "Solidity Audit", "API Design", "Copy Review", "Migration Plan"
   - Each card: voices used (lineage badges), personas, expected runtime, expected cost
3. **Personas page** (`/personas`) — the 10 built-in personas, what they hunt for, what they ignore. Sells the worldview-as-prompt idea.
4. **Author page** (post-marketplace) — top template authors with revenue stats.

---

## Storage schema (target — v0.7 final)

```sql
-- Voices: every routable model
CREATE TABLE voices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,                -- "cli" | "api"
  provider TEXT NOT NULL,
  model_id TEXT,
  lineage TEXT NOT NULL,
  input_cost_per_mtok REAL,
  output_cost_per_mtok REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Personas: the worldview a reviewer wears (LIVE)
CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  one_liner TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  recommended_lineage TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT REFERENCES personas(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Phases: per-template phase definitions (replaces hardcoded phases)
CREATE TABLE template_phases (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id),
  position INTEGER NOT NULL,
  phase_kind TEXT NOT NULL,            -- "doer" | "review" | "synthesis" | "decide"
  voice_id TEXT NOT NULL REFERENCES voices(id),
  persona_id TEXT NOT NULL REFERENCES personas(id),
  prompt_overrides TEXT,
  UNIQUE (template_id, position)
);
```

Migration of pre-v0.7 templates: convert each existing phase to a row with `persona_id = 'generic-reviewer'` (an 11th built-in for backwards compat), preserving voice assignments.

---

## MCP surface (target — v0.7 final)

```typescript
// LIVE
list_personas() → { personas: Persona[] }
invoke_persona({personaId, brief, repoPath?, files?, template?}) → ChatRef

// PLANNED
list_voices() → { voices: Voice[] }
list_templates() → { templates: Template[] }   // already live
run_template({templateId, brief, repoPath?, voiceOverrides?}) → ChatRef
```

Use case: from inside Claude Code, user types *"Ask chorus to have Sentinel and Cartographer review this branch"* → MCP fires two `invoke_persona` calls in parallel → cockpit shows both reviews live → results flow back into the editor.
