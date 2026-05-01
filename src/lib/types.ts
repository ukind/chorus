// Shared type contract between UI and daemon
// These types define the API wire format (camelCase, extracted from mock-data.ts)

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
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export type PhaseKind =
  | "review"
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
}

/**
 * One reviewer slot inside a phase. Lineage is the family of CLI to invoke
 * (claude, codex, gemini, …); models lists the specific model IDs the doer
 * should try in priority order. Empty `models` means "lineage default."
 */
export interface ReviewerCandidate {
  lineage: ReviewerLineage;
  models: string[];
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

// API response envelope
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
  };
}
