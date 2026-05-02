import type { ReviewerLineage } from "@/lib/types";

/**
 * Shared snapshot shapes for the run-viewer family.
 *
 * The run page assembles these from /api/run-artifacts/:chatId — the daemon
 * walks the chat directory and returns one ParticipantSnapshot per
 * doer/reviewer dir per round. The cockpit synthesises additional placeholder
 * snapshots from template config so reviewer cards appear immediately at
 * chat start instead of waiting for the directory to materialise.
 */
export interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: ReviewerLineage;
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
  /** Model id picked by the template for this slot, e.g. "claude-opus-4-7". */
  model?: string;
  /**
   * Resolved transport — what the shim ACTUALLY spawned at runtime.
   * Populated from the per-participant `_meta.json` sidecar the runner
   * writes. Differs from `agentName` + `model` when a single lineage has
   * multiple transports (e.g. moonshot/kimi can run via standalone `kimi`
   * CLI OR via `opencode -m opencode-go/kimi-k2.6`). Cards prefer these
   * fields over the template-default `model`/`agentName` so the user can
   * tell at a glance which path is in use.
   */
  binaryUsed?: string;
  modelUsed?: string;
  /**
   * Synthesised slot — no directory on disk yet. Present so we can render
   * placeholder reviewer cards from template config the moment the chat
   * starts, instead of leaving the user staring at a lone doer card.
   */
  pending?: boolean;
  /**
   * Wall-clock duration of the participant's CLI run, in ms. Captured from
   * the runner's `_stats.json` sidecar written at participant_done. Absent
   * for pending / still-working participants.
   */
  durationMs?: number;
  /**
   * Token usage reported by the upstream CLI's stream. Populated by shims
   * that surface usage in `message_done` (claude/anthropic today; others
   * fill in as parsers grow). Absent when the CLI didn't report it.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

export interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

export type ParticipantState = "pending" | "working" | "done" | "errored" | "idle";
