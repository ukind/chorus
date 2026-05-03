// Shared type contract between UI and daemon
// These types define the API wire format (camelCase, extracted from mock-data.ts)

export type ReviewerLineage =
  | "codex"
  | "gemini"
  | "opencode"
  | "claude"
  | "kimi"
  | "openrouter";

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
  agreedBy: string[];
}

export interface SynthesizedAnswer {
  verdict: "agree" | "partial" | "disagree";
  headline: string;
  summary: string;
  findings: SynthesizedFinding[];
  recommendation: string;
}

export interface Chat {
  id: string;
  /**
   * URL-friendly slug derived from `work` on creation. Present on
   * chats created after the slug migration; absent on legacy rows that
   * the daemon's backfill missed (or DBs older than the migration).
   * Use `chatHref(chat)` to build a URL that prefers slug → falls back
   * to id, so links keep working in both cases.
   */
  slug?: string;
  work: string;
  templateId: string;
  status:
    | "drafting"
    | "reviewing"
    | "approved"
    | "no_review"
    | "merged"
    | "blocked"
    | "cancelled"
    | "failed";
  currentPhaseIdx: number;
  yolo: boolean;
  attachedFiles?: string[];
  /** Optional absolute path to user's repo. Set at chat creation. */
  repoPath?: string;
  /** GitHub PR URL written by the Ship phase on success (status=merged). */
  prUrl?: string;
  /** Failure context written when Ship blocks (status=blocked). */
  shipError?: string;
  /** Artifact text supplied at chat creation for review-only templates.
   *  Undefined for full-pipeline templates. */
  artifact?: string;
  /** Final reviewer verdict from chat_done. Undefined until terminal. */
  verdict?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export type PhaseKind =
  | "review"
  | "review_only"
  | "plan"
  | "spec"
  | "tests"
  | "implement"
  | "verify"
  | "pr"
  | "divergence"
  | "recon";

export type PhaseState =
  | "queued"
  | "drafting"
  | "submitted"
  | "reviewing"
  | "approved"
  | "revising"
  | "merged"
  | "skipped"
  | "blocked";

export interface DoerSlot {
  lineage: ReviewerLineage;
  models: string[];
  /** Optional persona id — the runner prepends persona.system_prompt to the doer's ask. */
  persona?: string;
}

/**
 * One reviewer slot inside a phase. Lineage is the family of CLI to invoke
 * (claude, codex, gemini, …); models lists the specific model IDs the doer
 * should try in priority order. Empty `models` means "lineage default."
 */
export interface ReviewerCandidate {
  lineage: ReviewerLineage;
  models: string[];
  /** Optional persona id — the runner prepends persona.system_prompt to the reviewer's ask. */
  persona?: string;
}

export interface ReviewerRule {
  require: number;
  crossLineage: boolean;
  /** Lineages only — kept for legacy callers and the connection-status grid. */
  candidates: ReviewerLineage[];
  /**
   * Same candidates with the model assignment from the YAML preserved.
   * Run page reads this so each placeholder reviewer card can show its
   * model badge ("gpt-5.5") before the CLI has actually spawned. Index-
   * aligned with `candidates`.
   */
  candidatesWithModels: ReviewerCandidate[];
}

export interface PhaseInputs {
  include: string[];
  exclude: string[];
}

export interface IteratePolicy {
  max: number;
  onMax: "ask-user" | "loopback" | "fail";
  loopbackTo?: string;
}

export interface TemplatePhase {
  id: string;
  name: string;
  description: string;
  kind: PhaseKind;
  gate: "auto" | "ask-user";
  doer: DoerSlot;
  reviewer: ReviewerRule;
  inputs: PhaseInputs;
  iterate: IteratePolicy;
  blindSpots: BlindSpotPack[];
  execution: ExecutionMode;
  builtin: boolean;
  /** Artifact spec — only meaningful when kind === 'review_only'. Drives
   *  the cockpit textarea label/placeholder and the size cap. */
  artifact?: {
    label: string;
    hint: string;
    maxBytes: number;
  };
}

export type AgreementThreshold = "unanimous" | "majority" | "any";
export type ThresholdAction = "auto-finalize" | "ask-user";
export type ExecutionMode = "parallel" | "sequential";
export type DriverTarget =
  | "claude-code"
  | "cursor"
  | "codex-cli"
  | "windsurf"
  | "external";
export type BlindSpotPack =
  | "security"
  | "data"
  | "api"
  | "architecture"
  | "ops"
  | "performance";
export type NotifyChannel = "mcp-tool" | "webhook" | "dashboard-only";

export interface Template {
  id: string;
  name: string;
  description: string;
  category: "review" | "plan" | "debug" | "decide";
  phases: TemplatePhase[];
  agreementThreshold: AgreementThreshold;
  onThresholdMet: ThresholdAction;
  maxRounds: number;
  driver: DriverTarget;
  driverHandoff: boolean;
  verificationGate: "auto" | "run-tests" | "ask-user";
  costCapUsd: number;
  yoloDefault?: boolean;
  onError: "fallback" | "fail" | "ask-user";
  notify: NotifyChannel;
  yaml: string;
  authorHandle: string;
  forks: number;
  popularity: number;
}

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

export interface Settings {
  onboarded?: boolean;
  permissions?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
  webhooks?: Record<string, unknown>;
  /**
   * Models the user picked for the OpenCode CLI during onboarding (or
   * later in Settings). Qualified form: `opencode-go/kimi-k2.6`,
   * `opencode-zen/glm-5.1`, etc. Templates and voice pickers filter
   * available reviewers by this list when OpenCode is the lineage.
   */
  "opencode.enabled_models"?: string[];
  /**
   * Per-CLI enabled-models lists for the home-page fleet cards.
   * `<ui-lineage>.enabled_models` (e.g. `claude.enabled_models`,
   * `codex.enabled_models`, `gemini.enabled_models`,
   * `kimi.enabled_models`). Index signature kept generic so adding a new
   * lineage doesn't require a type change.
   */
  [key: `${string}.enabled_models`]: string[] | undefined;
}

export interface Secret {
  provider: string;
  kind: "api_key" | "cli_subscription";
  value?: string;
  meta?: Record<string, unknown>;
  updatedAt: number;
}

// Phase event from SSE stream
export interface PhaseEvent {
  id: number;
  chatId: string;
  phaseIdx: number;
  phaseKind: PhaseKind;
  role: "doer" | "reviewer";
  agentId?: string;
  state: PhaseState;
  output?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  startedAt: number;
  finishedAt?: number;
}

/**
 * UI-side helper: does the template's first phase require a runtime artifact?
 * Mirrors the daemon-side templateRequiresArtifact() so the new-chat form
 * can swap "Task" for "Artifact" without re-parsing YAML.
 */
export function isReviewOnlyTemplate(template: Pick<Template, "phases"> | null | undefined): boolean {
  if (!template) return false;
  return template.phases[0]?.kind === "review_only";
}

// API response envelope
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    /** Optional structured payload (e.g. zod issue list for validation errors). */
    details?: Record<string, unknown>;
  };
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
}
