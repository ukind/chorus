"use client";

/**
 * Real-data run view. Replaces LiveRunView (mock-driven) for the /runs/<id>
 * page. Renders the doer + reviewer cards with content read from disk on the
 * server and live progress streamed via SSE.
 *
 * Visual structure mirrors the prototype demo: status header, phase progress,
 * grid of reviewer cards. The mock simulation effects from LiveRunView are
 * gone — every value comes from a real source.
 *
 * Trade-off: when verdict-extraction logic gets richer (parsed findings,
 * severity tagging) it'll live in this component. Keeping it concentrated
 * here, not spread across LiveRunView's 768 lines.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RotateCw,
  Trash2,
  X,
  Link2,
  Repeat,
  Check,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { PhaseStepper, type PhaseState } from "@/components/phase-stepper";
import type { Template, ReviewerLineage } from "@/lib/types";
import { isReviewOnlyTemplate } from "@/lib/types";
import { uiLineageDefaultModel } from "@/lib/lineage-maps";
import { BriefHeading } from "./run-viewer/brief-heading";
import { RoundView } from "./run-viewer/round-view";
import type {
  ParticipantSnapshot,
  ParticipantWarning,
  RoundSnapshot,
} from "./run-viewer/types";
import type { TemplatePhase as MockTemplatePhase } from "@/lib/cockpit-types";

interface Props {
  chatId: string;
  initialStatus: string;
  initialRounds: RoundSnapshot[];
  template: Template | null;
  work: string;
  projectName?: string;
  /** PR URL when ship phase succeeded (chat status=merged). */
  initialPrUrl?: string;
  /** Ship phase failure detail when status=blocked. */
  initialShipError?: string;
  /** Reviewer-level outcome (separate from system-level status). When
   * status='approved' but verdict='request_changes', the run finished
   * but reviewers said no — header must reflect that, not green-stamp it. */
  initialVerdict?: string;
}

// Used when synthesising placeholder participants — picks a sensible CLI
// name for the lineage in case the real spawn hasn't happened yet.
const AGENT_LABEL: Record<string, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  gemini: "gemini-cli",
  opencode: "opencode-cli",
  kimi: "kimi-cli",
  // Matches the on-disk dir name the runner creates for HTTP-dispatched
  // voices (`reviewer-openrouter-<idx>`) so the synthesized pending card
  // reconciles cleanly with the real participant once dispatch finishes.
  openrouter: "openrouter",
};

// Templates use runtime lineage names ("anthropic", "openai", "google", ...)
// while the cockpit UI displays Linear-style brand names ("claude", "codex",
// "gemini", ...). This map translates between them so placeholder reviewer
// cards match the visual lineage of real spawns.
const TEMPLATE_TO_UI_LINEAGE: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  drafting: { text: "DRAFTING · doer working", color: "primary" },
  reviewing: { text: "REVIEWING · cross-lineage check", color: "primary" },
  approved: { text: "APPROVED", color: "emerald" },
  // Internal status name is 'merged' (legacy) — but chorus only opens
  // the PR; the human clicks Merge in GitHub. Label reflects reality.
  merged: { text: "PR OPENED", color: "emerald" },
  blocked: { text: "BLOCKED · ship error", color: "amber" },
  no_review: { text: "NO REVIEW · reviewers unavailable", color: "amber" },
  failed: { text: "FAILED", color: "destructive" },
  cancelled: { text: "CANCELLED", color: "muted" },
};

// When chat finishes with status='approved' (= run completed cleanly) the
// reviewer verdict still decides whether the work actually passed. A green
// "APPROVED" badge for a run where every reviewer said "request changes" was
// found in real-user testing on 2026-05-03 and is the kind of misread that
// gets bad code shipped. Verdict overrides the status label whenever it
// disagrees with the optimistic green path.
function deriveStatusMeta(
  status: string,
  verdict: string | undefined,
): { text: string; color: string } {
  if (status === "approved" && verdict && verdict !== "approved") {
    if (verdict === "request_changes") {
      return { text: "REVIEW · CHANGES REQUESTED", color: "amber" };
    }
    return { text: `REVIEW · ${verdict.toUpperCase()}`, color: "amber" };
  }
  return STATUS_LABEL[status] ?? { text: status.toUpperCase(), color: "muted" };
}

const STATUS_TEXT_COLOR: Record<string, string> = {
  primary: "text-primary",
  emerald: "text-emerald-400",
  amber: "text-amber-400",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

const STATUS_DOT_COLOR: Record<string, string> = {
  primary: "bg-primary",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

interface SSEEvent {
  chatId: string;
  type:
    | "phase_start"
    | "phase_progress"
    | "phase_done"
    | "phase_failed"
    | "cli_error"
    | "cli_warning"
    | "chat_done"
    | "participant_done";
  payload: Record<string, unknown>;
  ts: number;
}

/** Build the participant key the run page uses for matching SSE events
 * to participant cards. Must mirror the on-disk directory name format —
 * `<role>-<agentName>` (where agentName for reviewers includes the trailing
 * index, e.g. `opencode-cli-1`, `opencode-cli-2`).
 *
 * Was previously keyed on `role:lineage`, which collided whenever a phase
 * had multiple reviewers of the SAME lineage (e.g. two opencode reviewers
 * — deepseek + kimi). Both wrote to the same liveTails slot; whichever
 * fired its phase_progress event last won, so one card rendered the
 * other reviewer's stream. Run-page screenshot from the launch dogfood
 * caught this — kimi's card was showing deepseek's review text.
 *
 * Keying on the full directory name guarantees uniqueness because the
 * runner allocates a distinct -<idx> suffix per slot. */
function participantKey(role: string, agent: string): string {
  return `${role}-${agent}`;
}

export function LiveRunReal({
  chatId,
  initialStatus,
  initialRounds,
  template,
  work,
  projectName,
  initialPrUrl,
  initialShipError,
  initialVerdict,
}: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [verdict, setVerdict] = useState<string | undefined>(initialVerdict);
  const [rounds, setRounds] = useState<RoundSnapshot[]>(initialRounds);
  const [activeParticipants, setActiveParticipants] = useState<Set<string>>(
    new Set(),
  );
  const [prUrl, setPrUrl] = useState<string | undefined>(initialPrUrl);
  const [shipError, setShipError] = useState<string | undefined>(initialShipError);
  const [deleting, setDeleting] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const router = useRouter();

  // Live tail per participant (role:lineage → most recent ~500 chars). When
  // headless transport is in use, runner emits phase_progress events with
  // payload.output containing the latest accumulated tail. We render this
  // immediately for instant feedback, falling back to disk-polled content
  // when the SSE event hasn't arrived yet.
  const [liveTails, setLiveTails] = useState<Record<string, string>>({});

  // Live phase-completion counter, driven from phase_done SSE events. The
  // status-only `completedPhaseCount` derivation below stays at 0 until the
  // chat reaches a terminal state, which made multi-phase chats look
  // frozen for their entire duration (gemini caught this on the launch-eve
  // run-page review). Tracking phase_done events gives the stepper the
  // signal it needs to advance during the run. We persist max-seen instead
  // of last-seen because phase_done events have an explicit phaseIdx and
  // out-of-order arrival (rare but possible after a reattach replay).
  const [livePhaseDoneIdx, setLivePhaseDoneIdx] = useState<number>(-1);

  // Warnings keyed by participant dir name (the same key the on-disk
  // artifacts route returns). The runner emits cli_warning SSE events with
  // payload.agent === participant identifier (e.g. "claude-code" for doer,
  // "codex-cli-0" for reviewer). We accumulate per participant so multiple
  // warnings from the same runner stack on the card. Cleared at session
  // end when SSE closes.
  const [participantWarnings, setParticipantWarnings] = useState<
    Record<string, ParticipantWarning[]>
  >({});

  const isTerminal = [
    "approved",
    "merged",
    "blocked",
    "failed",
    "cancelled",
    "no_review",
  ].includes(status);

  // Periodic refresh of artifacts from disk (cheap server fetch). The SSE
  // stream tells us *when* something changed; this fetches the new content.
  // 8s instead of 4s because each refresh is a same-origin proxy + filesystem
  // read of every artifact in the chat dir; at 4s a 10-minute run did 150
  // round-trips, most of them unchanged. SSE deltas drive the live ticker.
  useEffect(() => {
    if (isTerminal) return;
    const refresh = async () => {
      try {
        const res = await fetch(`/api/run-artifacts/${chatId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { rounds: RoundSnapshot[] };
        setRounds(data.rounds);
      } catch {
        // ignore — next tick retries
      }
    };
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [chatId, isTerminal]);

  // SSE for live status + which participant is currently active.
  useEffect(() => {
    if (isTerminal) return;
    const es = new EventSource(`/api/daemon/chats/${chatId}/stream`);
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data) as SSEEvent;
        const role = e.payload.role as string | undefined;
        const agent = e.payload.agent as string | undefined;
        const phaseId = e.payload.phaseId as string | undefined;

        if (e.type === "phase_start" && role && agent && phaseId) {
          // Build a stable key so we can mark this participant as active.
          // Format mirrors directory naming: "<role>-<agentName>"
          // but we don't always know the suffix here, so do a prefix check.
          setActiveParticipants((prev) => {
            const next = new Set(prev);
            // Use phaseId+role+agent as a synthetic active key. Renderer maps
            // back to dir-name participants by matching role + lineage.
            next.add(`${role}-${agent}-${phaseId}`);
            return next;
          });
        }

        if (e.type === "phase_progress" && role && agent) {
          // Live text tail from headless transport — show immediately so the
          // user sees the agent typing, not a 4s-polled snapshot.
          const output = e.payload.output as string | undefined;
          if (typeof output === "string" && output.length > 0) {
            // Key by `<role>-<agentWithIdx>` — must match the on-disk
            // directory name format. The phase_progress payload's `agent`
            // field already includes the index suffix for reviewers
            // (`opencode-cli-1`, `opencode-cli-2`), so two reviewers of
            // the same lineage land in distinct liveTails entries instead
            // of clobbering each other.
            const key = participantKey(role, agent);
            setLiveTails((prev) => ({ ...prev, [key]: output }));
          }
        }

        if (e.type === "phase_done" || e.type === "phase_failed") {
          // Clear actives — next phase_start re-populates.
          setActiveParticipants(new Set());
          // Don't clear liveTails — let the disk-poll update them with the
          // final answer instead of flashing empty.
          // Advance the stepper on phase_done. phase_failed doesn't count
          // as a completed phase (the chat will land in a non-success
          // terminal status which the status-derived count handles).
          if (e.type === "phase_done") {
            const idx = (e.payload?.phaseIdx as number | undefined) ?? -1;
            if (Number.isInteger(idx) && idx >= 0) {
              setLivePhaseDoneIdx((prev) => (idx > prev ? idx : prev));
            }
          }
        }

        if (e.type === "cli_warning" && agent && role) {
          // Build the participant key in the same shape as the on-disk
          // dir name so the renderer can attach warnings to the right
          // card. doer → "doer-<agent>"; reviewer → already includes
          // the index in agent (e.g. "codex-cli-0"). The runner emits
          // agent="<name>-<idx>" for reviewers.
          const key = role === "doer" ? `doer-${agent}` : `reviewer-${agent}`;
          const kind = (e.payload.kind as string | undefined) ?? "warning";
          const message =
            (e.payload.message as string | undefined) ?? "(no detail)";
          setParticipantWarnings((prev) => {
            const next = { ...prev };
            const existing = next[key] ?? [];
            // Suppress duplicates (same kind + message). Repeated emissions
            // from a retried runner shouldn't pile up identical banners.
            if (
              existing.some(
                (w) => w.kind === kind && w.message === message,
              )
            ) {
              return prev;
            }
            next[key] = [...existing, { kind, message, ts: e.ts ?? Date.now() }];
            return next;
          });
        }

        if (e.type === "participant_done") {
          // The runner has just written `## DONE` to this participant's
          // answer.md. Pull artifacts immediately so the card flips from
          // WORKING to DONE without waiting for the 8s polling tick.
          // (The polling will re-confirm it on its next pass.)
          fetch(`/api/run-artifacts/${chatId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => data && setRounds(data.rounds))
            .catch(() => {});
        }

        if (e.type === "chat_done") {
          // The runner emits chat_done with payload.status as the canonical
          // terminal state ('completed' / 'merged' / 'blocked' / 'no_review').
          // Prefer that over verdict for the UI.
          const finalStatus = e.payload.status as string | undefined;
          if (finalStatus === "merged") setStatus("merged");
          else if (finalStatus === "blocked") setStatus("blocked");
          else if (finalStatus === "no_review") setStatus("no_review");
          else if (finalStatus === "failed") setStatus("failed");
          else if (finalStatus === "cancelled") setStatus("cancelled");
          else setStatus("approved");

          const finalVerdict = e.payload.verdict as string | undefined;
          if (typeof finalVerdict === "string" && finalVerdict.length > 0) {
            setVerdict(finalVerdict);
          }

          // Capture ship-phase outcome for the result banner.
          const payloadPrUrl = e.payload.prUrl as string | undefined;
          if (typeof payloadPrUrl === "string" && payloadPrUrl.length > 0) {
            setPrUrl(payloadPrUrl);
          }
          const payloadShipError = e.payload.shipError as string | undefined;
          if (typeof payloadShipError === "string" && payloadShipError.length > 0) {
            setShipError(payloadShipError);
          }

          es.close();
          // Final refresh of artifacts.
          fetch(`/api/run-artifacts/${chatId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => data && setRounds(data.rounds))
            .catch(() => {});
        }
      } catch {
        // skip malformed
      }
    };
    return () => es.close();
  }, [chatId, isTerminal]);

  const lineageMatchActive = (p: ParticipantSnapshot): boolean => {
    // Active keys are built as `${role}-${agent}-${phaseId}` in the
    // phase_start handler (where `agent` includes the per-slot index for
    // reviewers — e.g. `opencode-cli-1`). The participant's `p.participant`
    // is the on-disk dir name (`reviewer-opencode-cli-1`). Match by the
    // dir name as a strict prefix so two same-lineage reviewers don't both
    // light up when only one is streaming. Earlier code matched on
    // `${p.role}-${p.lineage}-` which is identical for `opencode-cli-1` /
    // `opencode-cli-2`, so the active glow leaked across cards. Same root
    // cause as the liveTails key collision fix; surfaced by the launch-eve
    // run-page review (deepseek + gemini both flagged it).
    const prefix = `${p.participant}-`;
    for (const k of activeParticipants) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  const meta = deriveStatusMeta(status, verdict);
  const totalPhases = template?.phases?.length ?? 1;

  // Phase completion is now driven by the chat's terminal status, not by
  // disk snapshots. The previous "any participant has an answer → phase
  // done" heuristic flipped the stepper to DONE the moment the doer wrote
  // its first byte, even though reviewers were still running and consensus
  // wasn't reached. With status-driven logic the phase only goes "done"
  // when the chat itself is in an approved-equivalent terminal state.
  const completedPhaseCount = useMemo(() => {
    if (status === "approved" || status === "merged") return totalPhases;
    if (status === "no_review" || status === "blocked") return totalPhases;
    if (status === "failed" || status === "cancelled") return 0;
    // drafting / reviewing — use the live phase_done event count so the
    // stepper advances mid-chat as each phase completes. Without this,
    // multi-phase chats sat at "0/N done" the entire run and snapped to
    // "N/N" only at terminal status — a bug gemini flagged in the
    // launch-eve run-page review. livePhaseDoneIdx is the highest
    // phaseIdx seen with phase_done; +1 converts to a count, clamped to
    // totalPhases for safety in case a stale replay sends an out-of-range
    // index.
    return Math.min(Math.max(0, livePhaseDoneIdx + 1), totalPhases);
  }, [status, totalPhases, livePhaseDoneIdx]);

  // Enrich rounds with model lookups + placeholder reviewer slots from the
  // template config. Without this, reviewer cards only appear once the
  // runner has spawned their dirs — leaving the doer card alone in the
  // viewport for the first 30-60s of a run with no hint that 2 reviewers
  // are about to chime in. Now we render placeholder cards from the start.
  const reviewOnly = useMemo(() => isReviewOnlyTemplate(template), [template]);
  const enrichedRounds = useMemo<RoundSnapshot[]>(() => {
    if (!template?.phases?.length) return rounds;
    const phase = template.phases[0];
    // Build expected slots from template config: 1 doer + N reviewers.
    // Review-only chats skip the doer slot — the artifact replaces it.
    type Slot = {
      role: "doer" | "reviewer";
      lineage: ReviewerLineage;
      model?: string;
      reviewerIdx?: number;
    };
    const toUiLineage = (templateLineage: string): ReviewerLineage =>
      TEMPLATE_TO_UI_LINEAGE[templateLineage] ?? (templateLineage as ReviewerLineage);
    // Fall back to the per-lineage default when a template's `models: []`
    // is empty so the card shows the actual model the runner will use.
    const resolveModel = (lineage: ReviewerLineage, models: string[] | undefined) =>
      models?.[0] ?? uiLineageDefaultModel(lineage);
    // OpenRouter dispatch overrides the slot's lineage for UI matching:
    // the runner creates `reviewer-openrouter-N` dirs (not
    // `reviewer-codex-N` or `-gemini-N`) regardless of the underlying
    // model's lineage. So a slot with model `openrouter:openai/gpt-4o-mini`
    // synthesises an "openrouter" UI card that reconciles with the real
    // participant once dispatch finishes. The voice's underlying lineage
    // stays accurate on the voices table for diversity scoring.
    const slotLineageForModel = (
      templateLineage: string,
      model: string | undefined,
    ): ReviewerLineage =>
      model && model.startsWith("openrouter:")
        ? "openrouter"
        : toUiLineage(templateLineage);
    const expectedSlots: Slot[] = [
      ...(reviewOnly
        ? []
        : (() => {
            const doerModel = phase.doer.models?.[0];
            const doerLineage = slotLineageForModel(phase.doer.lineage, doerModel);
            return [
              {
                role: "doer" as const,
                lineage: doerLineage,
                model: doerModel ?? resolveModel(doerLineage, phase.doer.models),
              },
            ];
          })()),
      // Use the structured candidatesWithModels field added to the parser
      // so we keep the model assignment per slot. The legacy `candidates`
      // string array is still emitted for connection-status grids that
      // don't care about models.
      ...(phase.reviewer?.candidatesWithModels ?? []).map((c, idx) => {
        const slotModel = c.models?.[0];
        const lineage = slotLineageForModel(c.lineage, slotModel);
        return {
          role: "reviewer" as const,
          lineage,
          model: slotModel ?? resolveModel(lineage, c.models),
          reviewerIdx: idx,
        };
      }),
    ];

    return rounds.map((round) => {
      const enrichedParticipants: ParticipantSnapshot[] = [];
      const seen = new Set<string>();
      for (const slot of expectedSlots) {
        const slotKey = slot.role === "doer"
          ? `doer-${slot.lineage}`
          : `reviewer-${slot.lineage}-${slot.reviewerIdx}`;
        // Find a real participant matching this slot
        const real = round.participants.find((p) => {
          if (slot.role === "doer") return p.role === "doer" && p.lineage === slot.lineage;
          // Reviewer match: same lineage + same idx (parsed from dir name)
          if (p.role !== "reviewer") return false;
          if (p.lineage !== slot.lineage) return false;
          const idxFromName = parseInt(p.participant.match(/-(\d+)$/)?.[1] ?? "0", 10);
          return idxFromName === slot.reviewerIdx;
        });
        if (real) {
          enrichedParticipants.push({
            ...real,
            model: slot.model,
            ...(participantWarnings[real.participant]
              ? { warnings: participantWarnings[real.participant] }
              : {}),
          });
          seen.add(real.participant);
        } else {
          // Synthesise a pending placeholder so the user sees the slot
          enrichedParticipants.push({
            participant: slotKey,
            role: slot.role,
            agentName: AGENT_LABEL[slot.lineage] ?? slot.lineage,
            lineage: slot.lineage,
            hasAnswer: false,
            model: slot.model,
            pending: true,
            ...(participantWarnings[slotKey]
              ? { warnings: participantWarnings[slotKey] }
              : {}),
          });
        }
      }
      // Append any unexpected participants (shouldn't happen, defensive)
      for (const p of round.participants) {
        if (!seen.has(p.participant)) {
          enrichedParticipants.push({
            ...p,
            ...(participantWarnings[p.participant]
              ? { warnings: participantWarnings[p.participant] }
              : {}),
          });
        }
      }
      return { ...round, participants: enrichedParticipants };
    });
  }, [rounds, template, participantWarnings]);

  // Find the most recent round to show prominently. Older rounds collapse below.
  const latestRound = enrichedRounds[enrichedRounds.length - 1];
  const olderRounds = enrichedRounds.slice(0, -1);

  return (
    <div className="flex h-full flex-col">
      {/* Compact sticky header — single row with breadcrumb, status, title,
          and actions. Brief expands on click for full prompt inspection.
          Phase stepper + ship-result banners moved into the body so the
          header stays under ~80px and reviewer cards fill the viewport. */}
      <div className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur-sm px-4 py-2 sm:px-8">
        <div className="flex w-full items-center gap-3">
          {/* Breadcrumb back link — tightened */}
          <Link
            href="/runs"
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden sm:inline">{projectName ?? "Runs"}</span>
          </Link>

          {/* Status dot — text label dropped as redundant with phase stepper.
              Tooltip carries the long form for screen readers / hover. */}
          <span
            title={meta.text}
            className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_COLOR[meta.color]} ${
              isTerminal ? "" : "animate-pulse-soft"
            }`}
          />

          {/* Template badge dropped — phase stepper already shows the phase
              name ("Code Review") below. Was duplicated information. */}

          {/* Title — single-line ellipsis, click to expand */}
          <div className="min-w-0 flex-1">
            <BriefHeading work={work} />
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-2">
              {/* Pause button removed — was decorative, no backend support
                  for mid-run pause. Resume after pause requires session
                  state we don't have today. Will reintroduce when the
                  daemon gains real pause/resume in v0.8. */}
              {status === "cancelled" || status === "failed" ? (
                <button
                  type="button"
                  disabled={retrying}
                  onClick={async () => {
                    setRetrying(true);
                    try {
                      const res = await fetch(`/api/daemon/chats/${chatId}/rerun`, {
                        method: "POST",
                      });
                      if (!res.ok) {
                        window.alert(
                          "Couldn't start a new run — Chorus didn't respond. Try restarting it from your terminal: chorus start",
                        );
                        setRetrying(false);
                        return;
                      }
                      const body = (await res.json()) as {
                        ok: boolean;
                        data?: { slug?: string; id?: string };
                        error?: { code?: string; message?: string };
                      };
                      // Daemon returns HTTP 200 with `{ok: false, error: {...}}`
                      // for validation/conflict failures (e.g. rerun-while-active).
                      // Without surfacing it the button just stops spinning and
                      // the user has no idea why nothing happened — flagged in
                      // retroactive review of PR #14 by opencode reviewers.
                      if (!body.ok) {
                        const msg = body.error?.message ?? "Unknown error from Chorus.";
                        window.alert(`Couldn't start a new run: ${msg}`);
                        setRetrying(false);
                        return;
                      }
                      const target = body.data?.slug ?? body.data?.id;
                      if (target) {
                        router.push(`/runs/${target}`);
                        router.refresh();
                      } else {
                        // ok:true with no slug/id is a daemon-side bug, but
                        // we still need to unstick the button.
                        window.alert(
                          "Chorus accepted the retry but didn't return a chat id. Refresh and try again.",
                        );
                        setRetrying(false);
                      }
                    } catch {
                      window.alert("Retry failed. Network error.");
                      setRetrying(false);
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
                  {retrying ? "Restarting…" : "Retry"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isTerminal}
                  onClick={async () => {
                    await fetch(`/api/daemon/chats/${chatId}/cancel`, { method: "POST" });
                    setStatus("cancelled");
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </button>
              )}
              {/* "Run again" — once the chat is terminal, give the user a
                  one-click re-entry to /new with the same template
                  pre-selected. They paste their (possibly revised) artifact
                  there. Without this button users had to find the template
                  manually. */}
              {isTerminal && template && (
                <Link
                  href={`/new?template=${encodeURIComponent(template.id)}`}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                >
                  <Repeat className="h-3.5 w-3.5" />
                  Run again
                </Link>
              )}
              {/* Copy URL — replaces an absent Share button. Two-second
                  affirmation tick so the user knows the click registered. */}
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(window.location.href);
                    setCopiedShare(true);
                    setTimeout(() => setCopiedShare(false), 2000);
                  } catch {
                    /* clipboard rejected (insecure ctx) — silent */
                  }
                }}
                title="Copy a link to this run"
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
              >
                {copiedShare ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Link2 className="h-3.5 w-3.5" />
                    Share
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Delete this chat permanently? This removes all reviewer output and history. You cannot undo this.",
                    )
                  ) {
                    return;
                  }
                  setDeleting(true);
                  try {
                    const res = await fetch(`/api/daemon/chats/${chatId}`, {
                      method: "DELETE",
                    });
                    if (res.ok) {
                      router.push("/runs");
                      router.refresh();
                    } else {
                      window.alert("Couldn't delete this chat — Chorus didn't respond. Try restarting it from your terminal: chorus start");
                      setDeleting(false);
                    }
                  } catch {
                    window.alert("Delete failed. Network error.");
                    setDeleting(false);
                  }
                }}
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
        </div>
      </div>

      {/* Secondary header — phase stepper, progress, ship-result banners.
          Lives in the scroll area, not in the sticky header, so reviewer
          cards get the full viewport once the user starts scrolling. */}
      <div className="border-b border-border bg-card/20 px-4 py-3 sm:px-8">
        <div className="mx-auto flex w-full flex-col gap-3">
          {/* Ship-phase outcome banner — green PR link when merged, amber
              error context when blocked. Only renders on terminal states. */}
          {prUrl && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  Pull request opened
                </div>
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  View PR →
                </a>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-emerald-200/70">
                {prUrl}
              </p>
            </div>
          )}
          {shipError && !prUrl && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                Ship phase blocked
              </div>
              <p className="mt-1 break-words font-mono text-[11px] text-amber-200/80">
                {shipError}
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                The reviewers approved the doer&apos;s output, but chorus
                couldn&apos;t open a PR. Resolve the issue above and re-run.
              </p>
            </div>
          )}

          {/* Phase stepper — one button per template phase, centered. */}
          {template?.phases && template.phases.length > 0 && (
            <div className="flex justify-center">
              <PhaseStepper
                phases={template.phases as unknown as MockTemplatePhase[]}
                activeIndex={Math.min(completedPhaseCount, totalPhases - 1)}
                states={template.phases.map((_, i): PhaseState => {
                  if (status === "approved") return "done";
                  if (status === "no_review") return i < completedPhaseCount ? "done" : "blocked";
                  if (status === "failed" || status === "cancelled")
                    return i < completedPhaseCount ? "done" : "skipped";
                  if (i < completedPhaseCount) return "done";
                  if (i === completedPhaseCount) return "active";
                  return "pending";
                })}
              />
            </div>
          )}

          {/* Progress strip — sits under the stepper so it reads as
              "this stepper's progress". Counts phases for multi-phase
              templates, rounds for single-phase + multi-round
              (e.g. bug-diagnose). Hidden when the run is a single shot. */}
          {(() => {
            const maxRounds = template?.maxRounds ?? 1;
            const isTerminal_ =
              status === "approved" ||
              status === "merged" ||
              status === "no_review" ||
              status === "blocked" ||
              status === "failed" ||
              status === "cancelled";
            // Three progress dimensions in priority: phases > rounds >
            // participants. Pick the first one that has more than one
            // unit to track. Single-phase + single-round + multi-reviewer
            // templates (e.g. tri-review) show "N / M complete" so the
            // user has a top-level signal even when the cards alone tell
            // the story.
            const showByPhases = totalPhases > 1;
            const showByRounds = !showByPhases && maxRounds > 1;
            const currentRound = enrichedRounds[enrichedRounds.length - 1];
            // Count reviewers only — the doer (or synthetic `doer-artifact`
            // slot in review-only chats) is its own participant on disk but
            // not part of the "N reviewers complete" mental model. Without
            // this filter a 4-reviewer review-only chat displays "x/5",
            // which is the bug surfaced 2026-05-01.
            const reviewerParticipants =
              currentRound?.participants.filter((p) => p.role === "reviewer") ?? [];
            const participantTotal = reviewerParticipants.length;
            const participantDone = reviewerParticipants.filter((p) => p.hasAnswer).length;
            const showByParticipants =
              !showByPhases && !showByRounds && participantTotal > 1;
            if (!showByPhases && !showByRounds && !showByParticipants)
              return null;
            const total = showByPhases
              ? totalPhases
              : showByRounds
                ? maxRounds
                : participantTotal;
            const completed = showByPhases
              ? Math.min(completedPhaseCount, totalPhases)
              : showByRounds
                ? Math.min(Math.max(rounds.length, 1), maxRounds)
                : participantDone;
            const display = showByPhases && isTerminal_ ? total : completed;
            const label = showByPhases
              ? `${display} / ${total} phases`
              : showByRounds
                ? `Round ${display} / ${total}`
                : `${display} / ${total} complete`;
            return (
              <div className="mx-auto flex w-full max-w-xs items-center gap-2">
                <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`transition-[width] duration-700 ease-out ${
                      status === "approved" ? "bg-emerald-400" : "bg-primary"
                    }`}
                    style={{
                      width: `${(display / total) * 100}%`,
                    }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {label}
                </span>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Body — full-width container. Reviewer outputs are text-heavy and
          benefit from the extra horizontal space. The 6xl cap was inherited
          from a marketing-style layout that doesn't fit a tool surface. */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full space-y-8">
          {rounds.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
              Waiting for first phase to start…
            </div>
          )}

          {latestRound && (
            <RoundView
              round={latestRound}
              isLatest
              activeFor={lineageMatchActive}
              liveTails={liveTails}
              chatTerminal={isTerminal}
              reviewOnly={reviewOnly}
              chatId={chatId}
            />
          )}

          {/* Review-only chats are single-pass by design — there is never an
              "earlier rounds" panel because there's exactly one round. Hide
              the affordance to avoid the empty <details> showing up. */}
          {!reviewOnly && olderRounds.length > 0 && (
            <details className="rounded-lg border border-border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">
                Earlier rounds ({olderRounds.length})
              </summary>
              <div className="space-y-6 border-t border-border p-4">
                {olderRounds
                  .slice()
                  .reverse()
                  .map((r) => (
                    <RoundView
                      key={r.round}
                      round={r}
                      activeFor={() => false}
                      liveTails={{}}
                      chatTerminal={isTerminal}
                    />
                  ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

