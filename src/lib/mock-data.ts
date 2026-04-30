// Static mock data for the prototype. Drives every screen.
// Real backend slots in here when the engine lands.

export type ReviewerLineage = "codex" | "gemini" | "opencode" | "claude" | "kimi";

export type AgentState =
  | "idle"
  | "working"
  | "writing"
  | "errored"
  | "done"
  | "disabled";

export interface Agent {
  id: string;
  name: string;
  lineage: ReviewerLineage;
  model: string;
  source: "byo" | "credits";
  status: "connected" | "disconnected" | "needs-auth";
}

export interface Reviewer {
  id: string;
  name: string;
  lineage: ReviewerLineage;
  model: string;
  state: AgentState;
  elapsedSeconds: number;
  bytes: number;
  streamedLines: string[];
  verdict?: "agree" | "partial" | "disagree";
  findingsCount?: number;
}

export interface SynthesizedFinding {
  severity: "critical" | "high" | "medium" | "low";
  text: string;
  agreedBy: string[]; // reviewer names
}

export interface SynthesizedAnswer {
  verdict: "agree" | "partial" | "disagree";
  headline: string;
  summary: string;
  findings: SynthesizedFinding[];
  recommendation: string;
}

export interface TaskRun {
  id: string;
  projectId: string;
  title: string;
  templateId: string;
  status: "running" | "done" | "needs-review" | "failed";
  createdAt: string;
  reviewers: Reviewer[];
  prompt: string;
  synthesizedAnswer?: string;
  synthesis?: SynthesizedAnswer;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  emoji: string;
  taskCount: number;
  activeRuns: number;
  lastActivity: string;
}

export type AgreementThreshold = "unanimous" | "majority" | "any";
export type ThresholdAction = "auto-finalize" | "ask-user";
export type ExecutionMode = "parallel" | "sequential";
export type DriverTarget =
  | "claude-code"
  | "cursor"
  | "codex-cli"
  | "windsurf"
  | "external"; // user picks at runtime
export type BlindSpotPack =
  | "security"
  | "data"
  | "api"
  | "architecture"
  | "ops"
  | "performance";
export type NotifyChannel = "mcp-tool" | "webhook" | "dashboard-only";

/** A single reviewer slot inside a phase — primary model + ordered fallbacks. */
export interface ReviewerSlot {
  lineage: ReviewerLineage;
  /** First entry is primary; rest are fallbacks (try in order on 429/timeout/5xx). */
  models: string[];
}

/** What a phase produces — drives the UI body and the artifact type. */
export type PhaseKind =
  | "review" // panel critiques an existing artifact
  | "plan" // doer drafts a plan
  | "spec" // doer derives spec / API contract
  | "tests" // doer writes tests
  | "implement" // doer writes code
  | "verify" // deterministic runner (tests / type-checks / lint)
  | "pr" // open PR / publish
  | "divergence" // optional: check if earlier phases need amendment
  | "recon"; // read-only exploration

/** Mechanical state of a phase — borrowed from LIZA's contract vocabulary. */
export type PhaseState =
  | "queued"
  | "drafting" // doer working
  | "submitted" // doer done, waiting for reviewer
  | "reviewing" // reviewer evaluating
  | "approved"
  | "revising" // reviewer rejected, doer iterating
  | "merged" // approved + downstream notified
  | "skipped"
  | "blocked"; // awaiting user (question / permission / cap)

/** Doer slot — the agent that produces this phase's output. */
export interface DoerSlot {
  lineage: ReviewerLineage;
  /** First entry is primary; rest are fallbacks. */
  models: string[];
}

/** Reviewer rule — how many must approve, must they differ from the doer, etc. */
export interface ReviewerRule {
  /** How many independent reviewers required to approve. 1 = single gate, 3 = panel. */
  require: number;
  /** Reviewer lineage MUST differ from doer (adversarial red/green default). */
  crossLineage: boolean;
  /** Allowed reviewer pool. If empty, any non-doer lineage is acceptable. */
  candidates: ReviewerLineage[];
}

/** What prior phases this phase's doer is allowed to read. */
export interface PhaseInputs {
  /** Phase IDs whose outputs are visible to this doer. Empty = all priors. */
  include: string[];
  /** Phase IDs whose outputs are EXPLICITLY blocked (info asymmetry). */
  exclude: string[];
}

/** Iteration policy when the reviewer rejects. */
export interface IteratePolicy {
  /** Max revise rounds within the phase before escalating. */
  max: number;
  /** What to do when max is hit. */
  onMax: "ask-user" | "loopback" | "fail";
  /** If onMax = loopback, which earlier phase to restart from. */
  loopbackTo?: string;
}

/** A phase is a sub-stage of the template. Built-in or user-authored, same shape. */
export interface TemplatePhase {
  id: string;
  name: string;
  description: string;
  kind: PhaseKind;
  /** Auto-proceed to next phase, or stop & wait for user (the "checkpoint"). */
  gate: "auto" | "ask-user";
  /** Single doer that produces the artifact. */
  doer: DoerSlot;
  /** How the work is reviewed — adversarial by default. */
  reviewer: ReviewerRule;
  /** What the doer can see from earlier phases. */
  inputs: PhaseInputs;
  /** Iteration / loop-back policy when reviewer rejects. */
  iterate: IteratePolicy;
  blindSpots: BlindSpotPack[];
  /** Run reviewers in parallel (default) or sequentially. */
  execution: ExecutionMode;
  /** True for opinionated built-in phases — user-authored phases are false. */
  builtin: boolean;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: "review" | "plan" | "debug" | "decide";

  /** Stages of work this template runs through. Single-phase templates are still phases[0]. */
  phases: TemplatePhase[];

  /** Consensus across reviewers within a phase. */
  agreementThreshold: AgreementThreshold;
  onThresholdMet: ThresholdAction;
  maxRounds: number;

  /** Driver picks up after consensus is reached. */
  driver: DriverTarget;
  /** Skip the implementation hand-off entirely (review-only templates). */
  driverHandoff: boolean;
  /** Verification gate before the driver writes code: ask user, run tests, or auto. */
  verificationGate: "auto" | "run-tests" | "ask-user";

  /** Hard stop when chat hits this cost (USD). 0 = no cap. */
  costCapUsd: number;

  /** Yolo mode — auto-approve all reviewer gates and ask-user prompts. Default false. */
  yoloDefault?: boolean;

  /** What we do when a model errors out: try next fallback, give up, or surface to user. */
  onError: "fallback" | "fail" | "ask-user";

  /** How the outer orchestrator (if any) gets notified when the chat finishes/blocks. */
  notify: NotifyChannel;

  yaml: string;
  authorHandle: string;
  forks: number;
  popularity: number; // 0–100
}

/** Legacy mirror — kept so older screens still compile. Synthesised from phases[0]. */
export function templateReviewerLineages(t: Template): ReviewerLineage[] {
  const p = t.phases[0];
  if (!p) return [];
  return [p.doer.lineage, ...p.reviewer.candidates];
}

/** Return the chips to render for a phase: doer first, then reviewers. */
export function phaseLineageChips(
  p: TemplatePhase,
): { lineage: ReviewerLineage; role: "doer" | "reviewer" }[] {
  const chips: { lineage: ReviewerLineage; role: "doer" | "reviewer" }[] = [
    { lineage: p.doer.lineage, role: "doer" },
  ];
  for (const c of p.reviewer.candidates) {
    chips.push({ lineage: c, role: "reviewer" });
  }
  return chips;
}

// ─── MCP tool surface (the bridge to outer orchestrators) ───────────────
// These describe the tools Chorus exposes so a parent Claude / Cursor / Codex
// session can spawn chats, wait for results, and resume blocked work.

export type McpToolStatus = "stable" | "beta" | "experimental";

export interface McpTool {
  name: string;
  signature: string;
  description: string;
  returns: string;
  status: McpToolStatus;
  example?: string;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "mm.create_chat",
    signature: "(project: string, prompt: string, template?: string) → ChatRef",
    description:
      "Create a new chat in a project. Returns immediately with a chat_id; reviewers run async.",
    returns: '{ chat_id, status: "running", started_at }',
    status: "stable",
    example: `mm.create_chat({
  project: "aurora",
  prompt: "Migrate orders to Postgres 17, zero-downtime.",
  template: "migration-plan"
})`,
  },
  {
    name: "mm.chat_status",
    signature: "(chat_id: string) → ChatStatus",
    description:
      "Cheap poll. Use mm.wait if you actually want to block until terminal.",
    returns:
      '{ status: "running" | "awaiting_user" | "done" | "errored", round, agreed, total }',
    status: "stable",
  },
  {
    name: "mm.wait",
    signature:
      "(chat_id: string, timeout_seconds?: number) → ChatResult | BlockedResult",
    description:
      "Long-poll until the chat hits a terminal or awaiting_user state. Designed to be the parent agent's main tool — returns the synthesis as tool result.",
    returns:
      '{ status, synthesis?: SynthesizedAnswer, blocked_reason?: "consensus_not_met" | "permission_required" | "cost_cap_reached" }',
    status: "stable",
    example: `const result = await mm.wait("c-2026-04-29-001");
if (result.status === "awaiting_user") {
  // surface deep link to user — they decide
}`,
  },
  {
    name: "mm.list_blocked",
    signature: "() → BlockedChat[]",
    description:
      "All chats currently waiting on user input. Lets the parent agent surface them in one prompt instead of one-by-one.",
    returns:
      "[{ chat_id, project, blocked_reason, deep_link, started_at }]",
    status: "stable",
  },
  {
    name: "mm.resume",
    signature: '(chat_id: string, decision: "accept" | "another-round" | "cancel") → ChatStatus',
    description:
      "Unblock a chat after the user has decided. Same effect as clicking the dashboard button.",
    returns: '{ status, round }',
    status: "stable",
  },
  {
    name: "mm.list_templates",
    signature: "(category?: string) → Template[]",
    description:
      "Discover what templates exist. The parent agent can then pick one for create_chat.",
    returns: "Template[]",
    status: "stable",
  },
  {
    name: "mm.cancel",
    signature: "(chat_id: string) → void",
    description: "Hard cancel — kills the tmux session, drops the chat row.",
    returns: "void",
    status: "stable",
  },
  {
    name: "mm.fan_out",
    signature: "(prompts: string[], template: string) → ChatRef[]",
    description:
      "Convenience: spawn N chats in parallel. Bounded by the workspace concurrency cap; overflow queues.",
    returns: "ChatRef[]",
    status: "beta",
  },
  // ── Configuration tools — let the parent agent set Chorus up for you ──
  {
    name: "mm.get_settings",
    signature: "() → Settings",
    description:
      "Read the current workspace settings (permissions per driver/reviewer, defaults, MCP, allowed dirs).",
    returns: "Settings (same shape as ~/.chorus/settings.yaml)",
    status: "beta",
  },
  {
    name: "mm.update_settings",
    signature: "(patch: Partial<Settings>) → Settings",
    description:
      "Partial update — merge keys you provide, leave others untouched. Logged in the audit trail.",
    returns: "Updated Settings",
    status: "beta",
    example: `mm.update_settings({
  permissions: {
    driver: { write: "auto", exec: "ask" },
    reviewer: { write: "block" }
  },
  allowed_directories: ["~/dev/chorus", "~/work/aurora"]
})`,
  },
  {
    name: "mm.create_template",
    signature: "(spec: TemplateSpec | yaml_string) → Template",
    description:
      "Create a new template. Accepts the full Template object as JSON, or a YAML string in the same shape as the YAML editor produces.",
    returns: "Template",
    status: "beta",
    example: `mm.create_template({
  name: "schema-migration-review",
  category: "review",
  phases: [{
    kind: "review",
    reviewers: [
      { lineage: "codex", models: ["gpt-5.5"] },
      { lineage: "gemini", models: ["gemini-3.1-pro-preview"] },
      { lineage: "opencode", models: ["kimi-k2.6", "deepseek-v4-pro"] }
    ],
    blind_spots: ["data", "security"]
  }],
  agreement_threshold: "unanimous",
  driver: "claude-code"
})`,
  },
  {
    name: "mm.update_template",
    signature: "(id: string, patch: Partial<TemplateSpec>) → Template",
    description:
      "Edit an existing template. Bumps the version number; in-flight chats keep using the snapshot at start time.",
    returns: "Template",
    status: "beta",
  },
  {
    name: "mm.delete_template",
    signature: "(id: string) → void",
    description:
      "Remove a template from the marketplace. Active chats finish; future chats can't pick it.",
    returns: "void",
    status: "beta",
  },
];

/** Mock state of currently-blocked chats — drives the MCP demo screen. */
export interface BlockedChat {
  chatId: string;
  project: string;
  template: string;
  blockedReason:
    | "consensus_not_met"
    | "permission_required"
    | "cost_cap_reached";
  startedAt: string;
  round: number;
  agreed: number;
  total: number;
  deepLink: string;
}

export const BLOCKED_CHATS: BlockedChat[] = [
  {
    chatId: "c-2026-04-29-014",
    project: "aurora",
    template: "migration-plan",
    blockedReason: "consensus_not_met",
    startedAt: "2026-04-29T14:08:00Z",
    round: 3,
    agreed: 2,
    total: 3,
    deepLink: "/runs/c-2026-04-29-014",
  },
  {
    chatId: "c-2026-04-29-013",
    project: "fleet",
    template: "code-review",
    blockedReason: "permission_required",
    startedAt: "2026-04-29T13:42:00Z",
    round: 1,
    agreed: 0,
    total: 3,
    deepLink: "/runs/c-2026-04-29-013",
  },
];

// ─── Agents (the user's connected fleet) ───────────────────────────────

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    lineage: "claude",
    model: "claude-opus-4-7",
    source: "byo",
    status: "connected",
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    lineage: "codex",
    model: "gpt-5.5",
    source: "byo",
    status: "connected",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    lineage: "gemini",
    model: "gemini-3.1-pro-preview",
    source: "byo",
    status: "connected",
  },
  {
    id: "kimi-credits",
    name: "Kimi K2.6",
    lineage: "opencode",
    model: "kimi-k2.6",
    source: "credits",
    status: "connected",
  },
  {
    id: "deepseek-credits",
    name: "DeepSeek V4 Pro",
    lineage: "opencode",
    model: "deepseek-v4-pro",
    source: "credits",
    status: "connected",
  },
  {
    id: "qwen3",
    name: "Qwen3 Max",
    lineage: "opencode",
    model: "qwen3-max",
    source: "credits",
    status: "needs-auth",
  },
];

// ─── Projects ───────────────────────────────────────────────────────────

export const PROJECTS: Project[] = [
  {
    id: "p-aurora",
    name: "Aurora dashboard",
    description: "Internal admin for the trading desk",
    emoji: "🌅",
    taskCount: 24,
    activeRuns: 2,
    lastActivity: "12 min ago",
  },
  {
    id: "p-pricewise",
    name: "PriceWise API",
    description: "Pricing service migration to Postgres",
    emoji: "💰",
    taskCount: 18,
    activeRuns: 0,
    lastActivity: "2 h ago",
  },
  {
    id: "p-orchard",
    name: "Orchard mobile",
    description: "React Native rewrite",
    emoji: "🌳",
    taskCount: 9,
    activeRuns: 1,
    lastActivity: "yesterday",
  },
];

// ─── Templates ──────────────────────────────────────────────────────────

/** Default 3-lineage reviewer panel with fallback ladders — used by all starter templates. */
const DEFAULT_PANEL: ReviewerSlot[] = [
  { lineage: "codex", models: ["gpt-5.5", "gpt-5.1"] },
  { lineage: "gemini", models: ["gemini-3.1-pro-preview", "gemini-2.5-pro"] },
  { lineage: "opencode", models: ["kimi-k2.6", "deepseek-v4-pro", "glm-4.6"] },
];

/** Build a panel-review phase (the existing Chorus shape — N peers + synthesizer). */
function panelPhase(args: {
  id: string;
  name: string;
  description: string;
  kind: PhaseKind;
  gate: "auto" | "ask-user";
  blindSpots?: BlindSpotPack[];
  inputsInclude?: string[];
}): TemplatePhase {
  return {
    id: args.id,
    name: args.name,
    description: args.description,
    kind: args.kind,
    gate: args.gate,
    doer: { lineage: "claude", models: ["claude-opus-4-7"] }, // synthesizer
    reviewer: {
      require: 3,
      crossLineage: true,
      candidates: ["codex", "gemini", "opencode"],
    },
    inputs: { include: args.inputsInclude ?? [], exclude: [] },
    iterate: { max: 3, onMax: "ask-user" },
    blindSpots: args.blindSpots ?? [],
    execution: "parallel",
    builtin: true,
  };
}

/** Build a produce-phase (single doer, single reviewer — adversarial). */
function producePhase(args: {
  id: string;
  name: string;
  description: string;
  kind: PhaseKind;
  doer: ReviewerLineage;
  doerModel?: string;
  reviewerCandidates: ReviewerLineage[];
  inputsInclude?: string[];
  inputsExclude?: string[];
  gate: "auto" | "ask-user";
  iterMax?: number;
  loopbackTo?: string;
}): TemplatePhase {
  const modelDefaults: Record<ReviewerLineage, string> = {
    claude: "claude-opus-4-7",
    codex: "gpt-5.5",
    gemini: "gemini-3.1-pro-preview",
    opencode: "kimi-k2.6",
    kimi: "kimi-k2.6",
  };
  return {
    id: args.id,
    name: args.name,
    description: args.description,
    kind: args.kind,
    gate: args.gate,
    doer: {
      lineage: args.doer,
      models: [args.doerModel ?? modelDefaults[args.doer]],
    },
    reviewer: {
      require: 1,
      crossLineage: true,
      candidates: args.reviewerCandidates,
    },
    inputs: {
      include: args.inputsInclude ?? [],
      exclude: args.inputsExclude ?? [],
    },
    iterate: {
      max: args.iterMax ?? 3,
      onMax: args.loopbackTo ? "loopback" : "ask-user",
      loopbackTo: args.loopbackTo,
    },
    blindSpots: [],
    execution: "sequential",
    builtin: true,
  };
}

export const TEMPLATES: Template[] = [
  {
    id: "t-architect-review",
    name: "Architect review",
    description:
      "Independent architecture critique from 3 model families. Surfaces blind spots before you commit to a design.",
    category: "review",
    phases: [
      panelPhase({
        id: "review",
        name: "Review",
        description: "Three independent architecture critiques.",
        kind: "review",
        gate: "ask-user",
        blindSpots: ["architecture", "security", "data"],
      }),
    ],
    agreementThreshold: "unanimous",
    onThresholdMet: "ask-user",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: false, // review-only template
    verificationGate: "ask-user",
    costCapUsd: 2.0,
    onError: "fallback",
    notify: "mcp-tool",
    authorHandle: "@chorus",
    forks: 142,
    popularity: 95,
    yaml: `name: architect-review
mode: plan
phases:
  - name: review
    execution: parallel
    blind_spots: [architecture, security, data]
    reviewers:
      - lineage: codex
        models: [gpt-5.5, gpt-5.1]
      - lineage: gemini
        models: [gemini-3.1-pro-preview, gemini-2.5-pro]
      - lineage: opencode
        models: [kimi-k2.6, deepseek-v4-pro, glm-4.6]
quorum:
  agreement_threshold: unanimous
  on_met: ask-user
  max_rounds: 3
driver: claude-code
driver_handoff: false
verification_gate: ask-user
cost_cap_usd: 2.00
on_error: fallback
notify: mcp-tool`,
  },
  {
    id: "t-bug-diagnose",
    name: "Bug diagnose",
    description:
      "Three independent diagnoses of a failing test or stack trace. No fix yet — just root-cause consensus.",
    category: "debug",
    phases: [
      panelPhase({
        id: "diagnose",
        name: "Diagnose",
        description: "Independent root-cause analyses.",
        kind: "review",
        gate: "auto",
        blindSpots: ["data", "ops"],
      }),
    ],
    agreementThreshold: "majority",
    onThresholdMet: "auto-finalize",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: true,
    verificationGate: "run-tests",
    costCapUsd: 1.0,
    onError: "fallback",
    notify: "mcp-tool",
    authorHandle: "@chorus",
    forks: 87,
    popularity: 82,
    yaml: `name: bug-diagnose
mode: major-bug
phases:
  - name: diagnose
    execution: parallel
    blind_spots: [data, ops]
    reviewers: [codex, gemini, opencode]
quorum:
  agreement_threshold: majority
  on_met: auto-finalize
  max_rounds: 3
driver: claude-code
driver_handoff: true
verification_gate: run-tests
cost_cap_usd: 1.00`,
  },
  {
    id: "t-migration-plan",
    name: "Migration plan",
    description:
      "Database / framework / language migration. Plan with consensus, then driver implements, opens PR.",
    category: "plan",
    phases: [
      panelPhase({
        id: "plan",
        name: "Plan",
        description: "Risk-ranked migration plans from each lineage.",
        kind: "plan",
        gate: "ask-user",
        blindSpots: ["data", "architecture", "ops"],
      }),
      producePhase({
        id: "implement",
        name: "Implement",
        description: "Driver writes the migration + tests.",
        kind: "implement",
        doer: "claude",
        reviewerCandidates: [],
        inputsInclude: ["plan"],
        gate: "auto",
        iterMax: 2,
      }),
      {
        id: "pr",
        name: "Open PR",
        description: "Branch, commit, open pull request.",
        kind: "pr",
        gate: "ask-user",
        doer: { lineage: "claude", models: ["claude-opus-4-7"] },
        reviewer: { require: 0, crossLineage: false, candidates: [] },
        inputs: { include: ["implement"], exclude: [] },
        iterate: { max: 1, onMax: "ask-user" },
        blindSpots: [],
        execution: "sequential",
        builtin: true,
      },
      panelPhase({
        id: "pr-review",
        name: "PR review",
        description: "Three lineages review the actual diff before merge.",
        kind: "review",
        gate: "auto",
        blindSpots: ["security", "data"],
        inputsInclude: ["pr", "implement", "plan"],
      }),
    ],
    agreementThreshold: "unanimous",
    onThresholdMet: "ask-user",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: true,
    verificationGate: "ask-user",
    costCapUsd: 3.0,
    onError: "ask-user",
    notify: "mcp-tool",
    authorHandle: "@chorus",
    forks: 64,
    popularity: 71,
    yaml: `name: migration-plan
mode: plan
phases:
  - name: plan
    execution: parallel
    blind_spots: [data, architecture, ops]
    reviewers: [codex, gemini, opencode]
quorum:
  agreement_threshold: unanimous
  on_met: ask-user
  max_rounds: 3
driver: claude-code
driver_handoff: true
verification_gate: ask-user
cost_cap_usd: 3.00
risk_ranking: true`,
  },
  {
    id: "t-code-review",
    name: "Code review",
    description:
      "PR-style review — paste diff, get 3 independent passes with severity-tagged findings.",
    category: "review",
    phases: [
      panelPhase({
        id: "review",
        name: "Review",
        description: "Severity-tagged PR review.",
        kind: "review",
        gate: "auto",
        blindSpots: ["security", "performance", "api"],
      }),
    ],
    agreementThreshold: "majority",
    onThresholdMet: "auto-finalize",
    maxRounds: 2,
    driver: "claude-code",
    driverHandoff: false,
    verificationGate: "auto",
    costCapUsd: 1.5,
    onError: "fallback",
    notify: "mcp-tool",
    authorHandle: "@chorus",
    forks: 211,
    popularity: 99,
    yaml: `name: code-review
mode: implement
phases:
  - name: review
    execution: parallel
    blind_spots: [security, performance, api]
    reviewers: [codex, gemini, opencode]
quorum:
  agreement_threshold: majority
  on_met: auto-finalize
  max_rounds: 2
driver: claude-code
driver_handoff: false
severity: required`,
  },
  {
    id: "t-decision-help",
    name: "Decision help",
    description:
      "Open-ended technical decisions (postgres vs mongo, REST vs GraphQL, etc). Reviewers argue both sides.",
    category: "decide",
    phases: [
      panelPhase({
        id: "debate",
        name: "Debate",
        description: "Reviewers argue opposing positions.",
        kind: "review",
        gate: "ask-user",
        blindSpots: ["architecture"],
      }),
    ],
    agreementThreshold: "any",
    onThresholdMet: "ask-user",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: false,
    verificationGate: "ask-user",
    costCapUsd: 2.0,
    onError: "fallback",
    notify: "mcp-tool",
    authorHandle: "@chorus",
    forks: 156,
    popularity: 89,
    yaml: `name: decision-help
mode: plan
phases:
  - name: debate
    execution: parallel
    reviewers: [codex, gemini, opencode]
quorum:
  agreement_threshold: any
  on_met: ask-user
  max_rounds: 3
driver: claude-code
driver_handoff: false
debate_mode: true`,
  },
  {
    // Adversarial red/green workflow per TheDailyClaude (Reddit r/ClaudeAI).
    // 7 phases, every phase has cross-lineage doer + reviewer, info asymmetry on impl.
    id: "t-red-green",
    name: "Red / green (adversarial)",
    description:
      "TheDailyClaude's flow: opus & codex play doer/reviewer round-robin; opencode implements without seeing tests; runner loops feedback without leaking test bodies. Catches a lot.",
    category: "plan",
    phases: [
      producePhase({
        id: "plan",
        name: "Plan",
        description: "Opus drafts the plan; Codex reviews.",
        kind: "plan",
        doer: "claude",
        doerModel: "claude-opus-4-7",
        reviewerCandidates: ["codex"],
        gate: "auto",
        iterMax: 2,
      }),
      producePhase({
        id: "spec",
        name: "Spec & API",
        description: "Codex derives spec/API from plan; Opus reviews.",
        kind: "spec",
        doer: "codex",
        doerModel: "gpt-5.5",
        reviewerCandidates: ["claude"],
        inputsInclude: ["plan"],
        gate: "auto",
        iterMax: 2,
      }),
      producePhase({
        id: "tests",
        name: "Tests",
        description: "Opus writes tests from spec; Codex reviews.",
        kind: "tests",
        doer: "claude",
        reviewerCandidates: ["codex"],
        inputsInclude: ["spec"],
        gate: "auto",
        iterMax: 2,
      }),
      producePhase({
        id: "implement",
        name: "Implement",
        description:
          "OpenCode (Kimi/GLM) implements based ONLY on spec — no test access.",
        kind: "implement",
        doer: "opencode",
        doerModel: "kimi-k2.6",
        reviewerCandidates: ["claude"],
        inputsInclude: ["spec"],
        inputsExclude: ["tests"], // critical: implementer can't see tests
        gate: "auto",
        iterMax: 5,
        loopbackTo: "spec",
      }),
      {
        id: "verify",
        name: "Verify",
        description:
          "Run tests against the implementation. On failure, feed back which tests failed (no parameters / expected results) — implementer iterates.",
        kind: "verify",
        gate: "auto",
        // The "doer" is the deterministic test runner — modeled as claude for the schema's sake
        doer: { lineage: "claude", models: ["test-runner"] },
        reviewer: { require: 0, crossLineage: false, candidates: [] },
        inputs: { include: ["implement", "tests"], exclude: [] },
        iterate: { max: 5, onMax: "loopback", loopbackTo: "implement" },
        blindSpots: [],
        execution: "sequential",
        builtin: true,
      },
      producePhase({
        id: "final-review",
        name: "Final review",
        description:
          "Codex reviews the implementation against plan + spec + tests; Opus arbitrates.",
        kind: "review",
        doer: "codex",
        reviewerCandidates: ["claude"],
        inputsInclude: ["plan", "spec", "tests", "implement"],
        gate: "ask-user",
        iterMax: 2,
      }),
      producePhase({
        id: "divergence",
        name: "Divergence check",
        description:
          "Optional: if impl diverges from spec, flag and (if justified) loop back to spec.",
        kind: "divergence",
        doer: "claude",
        reviewerCandidates: ["codex"],
        inputsInclude: ["plan", "spec", "tests", "implement"],
        gate: "auto",
        iterMax: 1,
        loopbackTo: "spec",
      }),
    ],
    agreementThreshold: "unanimous",
    onThresholdMet: "ask-user",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: true,
    verificationGate: "run-tests",
    costCapUsd: 5.0,
    onError: "fallback",
    notify: "mcp-tool",
    yoloDefault: false,
    authorHandle: "@TheDailyClaude (reddit)",
    forks: 0,
    popularity: 88,
    yaml: `# Adversarial red/green flow per TheDailyClaude on r/ClaudeAI.
# Cross-lineage adversarial pairs at every phase, with information asymmetry on the implement phase.
name: red-green-adversarial
mode: plan
phases:
  - id: plan
    kind: plan
    doer:     { lineage: claude,   models: [claude-opus-4-7] }
    reviewer: { require: 1, cross_lineage: true, candidates: [codex] }
  - id: spec
    kind: spec
    inputs:   { include: [plan] }
    doer:     { lineage: codex,    models: [gpt-5.5] }
    reviewer: { require: 1, cross_lineage: true, candidates: [claude] }
  - id: tests
    kind: tests
    inputs:   { include: [spec] }
    doer:     { lineage: claude,   models: [claude-opus-4-7] }
    reviewer: { require: 1, cross_lineage: true, candidates: [codex] }
  - id: implement
    kind: implement
    inputs:   { include: [spec], exclude: [tests] }   # info asymmetry
    doer:     { lineage: opencode, models: [kimi-k2.6, glm-4.6] }
    reviewer: { require: 1, cross_lineage: true, candidates: [claude] }
    iterate:  { max: 5, on_max: loopback, loopback_to: spec }
  - id: verify
    kind: verify
    inputs:   { include: [implement, tests] }
    runner:   test-runner    # deterministic, not LLM
    iterate:  { max: 5, on_max: loopback, loopback_to: implement }
    feedback: { include: [failing_test_names], exclude: [test_body, expected_results] }
  - id: final-review
    kind: review
    inputs:   { include: [plan, spec, tests, implement] }
    doer:     { lineage: codex,  models: [gpt-5.5] }
    reviewer: { require: 1, cross_lineage: true, candidates: [claude] }
    gate:     ask-user
  - id: divergence
    kind: divergence
    inputs:   { include: [plan, spec, tests, implement] }
    doer:     { lineage: claude, models: [claude-opus-4-7] }
    reviewer: { require: 1, cross_lineage: true, candidates: [codex] }
    iterate:  { max: 1, on_max: loopback, loopback_to: spec }
quorum:
  agreement_threshold: unanimous
  on_met: ask-user
  max_rounds: 3
driver: claude-code
driver_handoff: true
verification_gate: run-tests
cost_cap_usd: 5.00
on_error: fallback
notify: mcp-tool
yolo_default: false`,
  },
  {
    // Sequential hostile review per ApolloRaines (Reddit r/ClaudeAI 2026-04-30).
    // Each reviewer receives the ALREADY-HARDENED output from the previous one, and
    // hunts specifically for what the previous reviewer missed. Ratchet effect.
    id: "t-sequential-hostile",
    name: "Sequential hostile review",
    description:
      "Per ApolloRaines: R1 hunts broadly. R2 sees R1's output already hardened and hunts what R1 missed (integration / hidden assumptions). R3 hunts what R1+R2 missed (architectural drift / env). Slower than parallel but harder to fool with shared blind spots.",
    category: "review",
    phases: [
      // The artifact under review (in real use, this comes from upstream — this phase
      // is a placeholder so the chain has something to ratchet on).
      producePhase({
        id: "implement",
        name: "Implementation under review",
        description: "The code being reviewed. Loops back here on any blocking finding.",
        kind: "implement",
        doer: "claude",
        reviewerCandidates: [],
        gate: "auto",
        iterMax: 1,
      }),
      producePhase({
        id: "hostile-r1",
        name: "R1 · broad correctness hunt",
        description: "Reviewer 1 hunts correctness, security, completeness. Files findings.",
        kind: "review",
        doer: "codex",
        reviewerCandidates: [], // no internal review — the next phase IS the review
        inputsInclude: ["implement"],
        gate: "auto",
        iterMax: 3,
        loopbackTo: "implement",
      }),
      producePhase({
        id: "hostile-r2",
        name: "R2 · integration / hidden-assumptions hunt",
        description:
          "R2 sees the already-hardened output + R1's findings. Hunts what R1 missed: integration regressions, hidden assumptions, 'works on my machine' issues.",
        kind: "review",
        doer: "claude",
        reviewerCandidates: [],
        inputsInclude: ["implement", "hostile-r1"],
        gate: "auto",
        iterMax: 3,
        loopbackTo: "implement",
      }),
      producePhase({
        id: "hostile-r3",
        name: "R3 · architectural-drift hunt",
        description:
          "R3 sees implementation + R1 + R2 findings. Hunts what the prior two missed: architectural drift, environmental assumptions, scaling characteristics.",
        kind: "review",
        doer: "gemini",
        reviewerCandidates: [],
        inputsInclude: ["implement", "hostile-r1", "hostile-r2"],
        gate: "ask-user",
        iterMax: 3,
        loopbackTo: "implement",
      }),
    ],
    agreementThreshold: "unanimous", // applies to internal-review-with-reviewers; here no-op
    onThresholdMet: "ask-user",
    maxRounds: 3,
    driver: "claude-code",
    driverHandoff: false,
    verificationGate: "ask-user",
    costCapUsd: 4.0,
    onError: "fallback",
    notify: "mcp-tool",
    yoloDefault: false,
    authorHandle: "@ApolloRaines (reddit)",
    forks: 0,
    popularity: 78,
    yaml: `# Sequential hostile review per ApolloRaines on r/ClaudeAI.
# Each reviewer receives the already-hardened output from the previous one and
# hunts SPECIFICALLY for what the prior reviewer missed.
# Ratchet effect: each stage hardens the artifact further.
name: sequential-hostile-review
mode: implement
phases:
  - id: implement
    kind: implement
    doer:     { lineage: claude, models: [claude-opus-4-7] }
    iterate:  { max: 1, on_max: ask-user }   # the artifact under review
  - id: hostile-r1
    kind: review
    inputs:   { include: [implement] }
    doer:     { lineage: codex, models: [gpt-5.5] }
    prompt_focus: "correctness, security, completeness — broad coverage"
    iterate:  { max: 3, on_max: loopback, loopback_to: implement }
  - id: hostile-r2
    kind: review
    inputs:   { include: [implement, hostile-r1] }   # sees prior reviewer's findings
    doer:     { lineage: claude, models: [claude-opus-4-7] }
    prompt_focus: "what R1 missed: integration regressions, hidden assumptions, 'works on my machine'"
    iterate:  { max: 3, on_max: loopback, loopback_to: implement }
  - id: hostile-r3
    kind: review
    inputs:   { include: [implement, hostile-r1, hostile-r2] }
    doer:     { lineage: gemini, models: [gemini-3.1-pro-preview] }
    prompt_focus: "what R1+R2 missed: architectural drift, environmental assumptions, scaling"
    iterate:  { max: 3, on_max: loopback, loopback_to: implement }
    gate:     ask-user
quorum:
  # Quorum is implicit — each stage is a single hostile reviewer with veto power.
  # If you want a final consensus check, add a panelPhase after R3.
  agreement_threshold: unanimous
  on_met: ask-user
driver: claude-code
driver_handoff: false
cost_cap_usd: 4.00`,
  },
];

// ─── Reviewer streams (canned for the live grid) ────────────────────────
// Each line will be revealed over time to fake "live" output.

const codexStream = [
  "Reading <task> block.",
  "Reading <relevant-code> — 7 files, 4,219 LOC.",
  "Considering: schema choice, migration safety, blast radius.",
  "Identified 2 critical concerns:",
  "  • Composite index on (account_id, created_at) is missing.",
  "  • The migration drops a column without a backfill — data loss risk.",
  "Cross-checking against architecture-docs… consistent.",
  "Writing findings.",
];

const geminiStream = [
  "Parsing pack.xml (1,714 lines).",
  "Approach: independent code-path trace, no anchoring on driver's proposal.",
  "Found 3 issues:",
  "  • [critical] Race condition in process_batch — two workers can claim the same row.",
  "  • [high] N+1 in OrderListView — 240ms p95 will become 2.4s at scale.",
  "  • [medium] Test coverage gap on the rollback path.",
  "Verdict: partial — fix critical before merge.",
];

const opencodeStream = [
  "@./pack.xml read.",
  "Lineage diversity check: am I the only opencode reviewer? yes.",
  "Looking for what codex+gemini might have missed…",
  "  • [high] Auth token is logged in plaintext at error.ts:142 — security issue.",
  "  • The new feature flag has no kill-switch path in the deployment doc.",
  "Agreement with codex on composite-index issue.",
  "Done.",
];

// ─── Round 2 streams ────────────────────────────────────────────────────
// Each reviewer sees round 1's findings from peers + own, asked to converge.

const codexStreamR2 = [
  "Re-reading round 1 findings from gemini-2 and deepseek.",
  "Updating my position:",
  "  • Race condition in process_batch: gemini-2 is right — I missed it.",
  "  • Composite index: confirmed (deepseek concurs).",
  "  • Backfill: still a blocker on its own.",
  "Verdict: agree with consolidated finding list.",
];

const geminiStreamR2 = [
  "Reviewing round 1 cross-findings.",
  "Codex's column-drop point is fair — adjusting verdict.",
  "DeepSeek's auth-log point is real but out-of-scope for the migration; tag follow-up.",
  "Race condition + missing index + backfill: all stand.",
  "Verdict: agree on the 3 critical/high findings.",
];

const opencodeStreamR2 = [
  "Reading peers' round 1 outputs.",
  "Conceding the composite-index point as consolidated.",
  "Backfill risk: yes — codex was right.",
  "Race condition: confirming gemini-2's analysis.",
  "Auth-log issue: marked follow-up, not migration blocker.",
  "Done.",
];

// ─── Active task run (powers the live grid screen) ──────────────────────

export const ACTIVE_RUN: TaskRun = {
  id: "r-2026-04-29-001",
  projectId: "p-aurora",
  title: "Migration plan: Aurora orders to Postgres 17",
  templateId: "t-migration-plan",
  status: "running",
  createdAt: "2026-04-29T11:42:08Z",
  prompt:
    "Migrate Aurora's orders table from MySQL 8 to Postgres 17. Zero-downtime requirement. Schema has 14M rows, 8 indices, 3 FK relationships. Propose migration sequence and call out risks.",
  reviewers: [
    {
      id: "r-codex",
      name: "codex-1",
      lineage: "codex",
      model: "gpt-5.5",
      state: "writing",
      elapsedSeconds: 87,
      bytes: 3422,
      streamedLines: codexStream,
      findingsCount: 2,
    },
    {
      id: "r-gemini",
      name: "gemini-2",
      lineage: "gemini",
      model: "gemini-3.1-pro-preview",
      state: "working",
      elapsedSeconds: 92,
      bytes: 1840,
      streamedLines: geminiStream,
      verdict: "partial",
      findingsCount: 3,
    },
    {
      id: "r-deepseek",
      name: "deepseek-1",
      lineage: "opencode",
      model: "deepseek-v4-pro",
      state: "done",
      elapsedSeconds: 64,
      bytes: 4112,
      streamedLines: opencodeStream,
      verdict: "agree",
      findingsCount: 2,
    },
  ],
  synthesis: {
    verdict: "partial",
    headline:
      "Partial agreement — fix two critical issues before the migration ships.",
    summary:
      "All three reviewers concur the Postgres 17 migration sequence is sound, but two critical blockers must land first. One security note from DeepSeek is unique but worth a follow-up.",
    findings: [
      {
        severity: "critical",
        text: "Race condition in process_batch — two workers can claim the same row.",
        agreedBy: ["codex-1", "gemini-2"],
      },
      {
        severity: "critical",
        text: "Composite index on (account_id, created_at) is missing — required for the cutover query plan.",
        agreedBy: ["codex-1", "deepseek-1"],
      },
      {
        severity: "high",
        text: "Migration drops a column without a backfill — data loss risk.",
        agreedBy: ["codex-1"],
      },
      {
        severity: "high",
        text: "Auth token logged in plaintext at error.ts:142 — security issue.",
        agreedBy: ["deepseek-1"],
      },
      {
        severity: "medium",
        text: "Test coverage gap on the rollback path.",
        agreedBy: ["gemini-2"],
      },
    ],
    recommendation:
      "Block merge until both critical findings are resolved. Open a follow-up ticket for the auth-logging fix.",
  },
};

// ─── Round 2 — round 1 outputs combined, reviewers asked to converge ────

export const ROUND_2_REVIEWERS: Reviewer[] = [
  {
    id: "r-codex",
    name: "codex-1",
    lineage: "codex",
    model: "gpt-5.5",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: codexStreamR2,
  },
  {
    id: "r-gemini",
    name: "gemini-2",
    lineage: "gemini",
    model: "gemini-3.1-pro-preview",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: geminiStreamR2,
  },
  {
    id: "r-deepseek",
    name: "deepseek-1",
    lineage: "opencode",
    model: "deepseek-v4-pro",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: opencodeStreamR2,
  },
];

// ─── Phase 3 — PR review streams (reviewing the actual diff) ────────────

const codexPrStream = [
  "Pulling PR diff (4 files, +165 −6).",
  "Walking through src/jobs/process_batch.ts — claim wraps in SELECT FOR UPDATE.",
  "  • [low] Index hint missing on the SKIP LOCKED predicate, but Postgres planner handles it.",
  "Looks aligned with the agreed plan. No blocker.",
  "Verdict: approve.",
];

const geminiPrStream = [
  "Reading diff against the synthesis we agreed on in Plan.",
  "Migration 0042_orders_idx.sql ✓ matches the composite-index spec.",
  "tests/process_batch.test.ts ✓ — covers the concurrent-claim case.",
  "  • [low] The backfill chunk size is 10k; consider exposing as env for staging.",
  "Verdict: approve.",
];

const opencodePrStream = [
  "Cross-checking with my Plan-phase output.",
  "Backfill respects soft-deleted rows per the user decision in round 2 ✓.",
  "  • [medium] No rollback migration committed yet — flag for follow-up.",
  "Implementation matches consensus. Approve with the rollback follow-up.",
  "Done.",
];

export const PR_REVIEWERS: Reviewer[] = [
  {
    id: "r-codex",
    name: "codex-1",
    lineage: "codex",
    model: "gpt-5.5",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: codexPrStream,
  },
  {
    id: "r-gemini",
    name: "gemini-2",
    lineage: "gemini",
    model: "gemini-3.1-pro-preview",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: geminiPrStream,
  },
  {
    id: "r-deepseek",
    name: "deepseek-1",
    lineage: "opencode",
    model: "deepseek-v4-pro",
    state: "working",
    elapsedSeconds: 0,
    bytes: 0,
    streamedLines: opencodePrStream,
  },
];

export const PR_REVIEW_SYNTHESIS: SynthesizedAnswer = {
  verdict: "agree",
  headline: "PR approved by all 3 reviewers — safe to merge.",
  summary:
    "Implementation matches the Plan-phase consensus. Two non-blocking nits flagged for follow-up.",
  findings: [
    {
      severity: "low",
      text: "Index hint on SKIP LOCKED is omitted (planner handles it).",
      agreedBy: ["codex-1"],
    },
    {
      severity: "low",
      text: "Backfill chunk size is hard-coded — consider env var for staging.",
      agreedBy: ["gemini-2"],
    },
    {
      severity: "medium",
      text: "No rollback migration committed — open a follow-up ticket.",
      agreedBy: ["deepseek-1"],
    },
  ],
  recommendation:
    "Merge approved. Open follow-up ticket for the rollback migration.",
};

export const ROUND_2_SYNTHESIS: SynthesizedAnswer = {
  verdict: "agree",
  headline: "Consensus reached after round 2.",
  summary:
    "All three reviewers converged on the same 3 blockers after exchanging round-1 findings. Auth-logging issue de-scoped to a follow-up ticket per all-three agreement.",
  findings: [
    {
      severity: "critical",
      text: "Race condition in process_batch — two workers can claim the same row.",
      agreedBy: ["codex-1", "gemini-2", "deepseek-1"],
    },
    {
      severity: "critical",
      text: "Composite index on (account_id, created_at) is missing.",
      agreedBy: ["codex-1", "gemini-2", "deepseek-1"],
    },
    {
      severity: "high",
      text: "Migration drops a column without a backfill — data loss risk.",
      agreedBy: ["codex-1", "gemini-2", "deepseek-1"],
    },
  ],
  recommendation:
    "All 3 lineages agree — safe to apply with the 3 blockers resolved. File follow-up for auth-logging.",
};

// ─── Tasks list (powers project view) ───────────────────────────────────

export const TASKS_BY_PROJECT: Record<string, TaskRun[]> = {
  "p-aurora": [
    ACTIVE_RUN,
    {
      id: "r-2026-04-29-002",
      projectId: "p-aurora",
      title: "Code review: dashboard pagination refactor",
      templateId: "t-code-review",
      status: "needs-review",
      createdAt: "2026-04-29T10:14:00Z",
      prompt: "Review the diff in src/dashboard/* for the new cursor-based pagination.",
      reviewers: [],
      synthesizedAnswer:
        "All 3 reviewers agree the pagination logic is correct; codex flags an off-by-one in the empty-state.",
    },
    {
      id: "r-2026-04-29-003",
      projectId: "p-aurora",
      title: "Decision: Redis vs in-process LRU for hot cache",
      templateId: "t-decision-help",
      status: "done",
      createdAt: "2026-04-29T09:01:00Z",
      prompt: "Should we use Redis or in-process LRU for the hot order cache?",
      reviewers: [],
      synthesizedAnswer:
        "2/3 lean Redis (durability + multi-instance); gemini argues in-process if you can accept cold-start. Recommendation: Redis.",
    },
    {
      id: "r-2026-04-28-007",
      projectId: "p-aurora",
      title: "Architect review: new pricing-engine v2 design",
      templateId: "t-architect-review",
      status: "done",
      createdAt: "2026-04-28T18:32:00Z",
      prompt: "Review the v2 pricing engine plan in planning/pricing-v2.md.",
      reviewers: [],
      synthesizedAnswer:
        "Consensus: split rule-engine from pricing-engine. Concerns about latency budget — see findings.",
    },
  ],
  "p-pricewise": [],
  "p-orchard": [],
};
