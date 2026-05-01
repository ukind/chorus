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
   * Synthesised slot — no directory on disk yet. Present so we can render
   * placeholder reviewer cards from template config the moment the chat
   * starts, instead of leaving the user staring at a lone doer card.
   */
  pending?: boolean;
}

export interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

export type ParticipantState = "pending" | "working" | "done" | "errored" | "idle";
