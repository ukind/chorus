"use client";

/**
 * Real-data run view for the /runs/<id> page. Renders doer + reviewer
 * cards with content read from disk on the server and live progress
 * streamed via SSE.
 *
 * Visual structure mirrors the prototype demo: status header, phase
 * progress, grid of reviewer cards. Mock simulation effects from the
 * v0.6 LiveRunView are gone — every value comes from a real source.
 *
 * Header actions live in `header-actions.tsx`, the secondary stepper
 * in `phase-progress.tsx`, and the placeholder-slot synthesis in
 * `enrich-rounds.ts`.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isReviewOnlyTemplate, type Template } from "@/lib/types";
import { BriefHeading } from "../run-viewer/brief-heading";
import { RoundView } from "../run-viewer/round-view";
import type {
  ParticipantSnapshot,
  ParticipantWarning,
  RoundSnapshot,
} from "../run-viewer/types";
import { enrichRounds } from "./enrich-rounds";
import { HeaderActions } from "./header-actions";
import {
  deriveStatusMeta,
  participantKey,
  STATUS_DOT_COLOR,
  TERMINAL_STATUSES,
  type SSEEvent,
} from "./helpers";
import { PhaseProgress } from "./phase-progress";

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

  // Live tail per participant (`<role>-<agentName>` → most recent ~500
  // chars). When headless transport is in use, runner emits
  // phase_progress events with payload.output containing the latest
  // accumulated tail. Render this immediately for instant feedback,
  // falling back to disk-polled content when the SSE event hasn't
  // arrived yet.
  const [liveTails, setLiveTails] = useState<Record<string, string>>({});

  // Live phase-completion counter, driven from phase_done SSE events.
  // The status-only `completedPhaseCount` derivation stays at 0 until
  // the chat reaches a terminal state, which made multi-phase chats
  // look frozen for their entire duration. Tracking phase_done gives
  // the stepper the signal it needs to advance during the run. Persist
  // max-seen instead of last-seen because phase_done events carry an
  // explicit phaseIdx and out-of-order arrival is rare-but-possible
  // after a reattach replay.
  const [livePhaseDoneIdx, setLivePhaseDoneIdx] = useState<number>(-1);

  // Warnings keyed by participant dir name (same key the on-disk
  // artifacts route returns). The runner emits cli_warning events with
  // payload.agent === participant identifier (e.g. "claude-code" for
  // doer, "codex-cli-0" for reviewer). Multiple warnings stack on the
  // card; cleared at session end when SSE closes.
  const [participantWarnings, setParticipantWarnings] = useState<
    Record<string, ParticipantWarning[]>
  >({});

  const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(status);

  // Periodic refresh of artifacts from disk (cheap server fetch). The
  // SSE stream tells us *when* something changed; this fetches the new
  // content. 8s instead of 4s because each refresh is a same-origin
  // proxy + filesystem read of every artifact in the chat dir; at 4s a
  // 10-minute run did 150 round-trips, most of them unchanged. SSE
  // deltas drive the live ticker.
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
          // Format mirrors directory naming: "<role>-<agentName>" plus
          // phaseId so renderer maps back to dir-name participants by
          // matching role + lineage.
          setActiveParticipants((prev) => {
            const next = new Set(prev);
            next.add(`${role}-${agent}-${phaseId}`);
            return next;
          });
        }

        if (e.type === "phase_progress" && role && agent) {
          const output = e.payload.output as string | undefined;
          if (typeof output === "string" && output.length > 0) {
            // Keying must match the on-disk directory name format. The
            // payload's `agent` already includes the index suffix for
            // reviewers (`opencode-cli-1`, `opencode-cli-2`), so two
            // reviewers of the same lineage land in distinct liveTails
            // entries instead of clobbering each other.
            const key = participantKey(role, agent);
            setLiveTails((prev) => ({ ...prev, [key]: output }));
          }
        }

        if (e.type === "phase_done" || e.type === "phase_failed") {
          // Clear actives — next phase_start re-populates. Don't clear
          // liveTails — let the disk-poll update them with the final
          // answer instead of flashing empty.
          setActiveParticipants(new Set());
          if (e.type === "phase_done") {
            const idx = (e.payload?.phaseIdx as number | undefined) ?? -1;
            if (Number.isInteger(idx) && idx >= 0) {
              setLivePhaseDoneIdx((prev) => (idx > prev ? idx : prev));
            }
          }
        }

        if (e.type === "cli_warning" && agent && role) {
          // doer → "doer-<agent>"; reviewer → already includes the
          // index in agent (e.g. "codex-cli-0").
          const key = role === "doer" ? `doer-${agent}` : `reviewer-${agent}`;
          const kind = (e.payload.kind as string | undefined) ?? "warning";
          const message =
            (e.payload.message as string | undefined) ?? "(no detail)";
          setParticipantWarnings((prev) => {
            const next = { ...prev };
            const existing = next[key] ?? [];
            // Suppress duplicates (same kind + message). Repeated
            // emissions from a retried runner shouldn't pile up
            // identical banners.
            if (existing.some((w) => w.kind === kind && w.message === message)) {
              return prev;
            }
            next[key] = [...existing, { kind, message, ts: e.ts ?? Date.now() }];
            return next;
          });
        }

        if (e.type === "participant_done") {
          // The runner has just written `## DONE` to this participant's
          // answer.md. Pull artifacts immediately so the card flips
          // from WORKING to DONE without waiting for the 8s polling
          // tick.
          fetch(`/api/run-artifacts/${chatId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => data && setRounds(data.rounds))
            .catch(() => {});
        }

        if (e.type === "chat_done") {
          // Runner emits chat_done with payload.status as the canonical
          // terminal state ('completed' / 'merged' / 'blocked' /
          // 'no_review'). Prefer that over verdict for the UI.
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

          const payloadPrUrl = e.payload.prUrl as string | undefined;
          if (typeof payloadPrUrl === "string" && payloadPrUrl.length > 0) {
            setPrUrl(payloadPrUrl);
          }
          const payloadShipError = e.payload.shipError as string | undefined;
          if (typeof payloadShipError === "string" && payloadShipError.length > 0) {
            setShipError(payloadShipError);
          }

          es.close();
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

  /** Active keys are built as `${role}-${agent}-${phaseId}` in the
   * phase_start handler (where `agent` includes the per-slot index for
   * reviewers — e.g. `opencode-cli-1`). The participant's
   * `p.participant` is the on-disk dir name (`reviewer-opencode-cli-1`).
   * Match by dir name as a strict prefix so two same-lineage reviewers
   * don't both light up when only one is streaming. Earlier code
   * matched on `${p.role}-${p.lineage}-` which is identical for
   * `opencode-cli-1` / `opencode-cli-2`, so the active glow leaked. */
  const lineageMatchActive = (p: ParticipantSnapshot): boolean => {
    const prefix = `${p.participant}-`;
    for (const k of activeParticipants) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  const meta = deriveStatusMeta(status, verdict);
  const totalPhases = template?.phases?.length ?? 1;

  // Phase completion is driven by terminal status (not disk snapshots).
  // The previous "any participant has an answer → phase done" heuristic
  // flipped the stepper to DONE the moment the doer wrote its first
  // byte, even though reviewers were still running and consensus wasn't
  // reached. With status-driven logic the phase only goes "done" when
  // the chat itself is in an approved-equivalent terminal state.
  //
  // While drafting/reviewing, livePhaseDoneIdx (the highest phaseIdx
  // seen with phase_done; +1 converts to a count, clamped to
  // totalPhases for safety in case a stale replay sends an out-of-range
  // index) provides the live signal so multi-phase chats don't sit at
  // "0/N done" the entire run.
  const completedPhaseCount = useMemo(() => {
    if (status === "approved" || status === "merged") return totalPhases;
    if (status === "no_review" || status === "blocked") return totalPhases;
    if (status === "failed" || status === "cancelled") return 0;
    return Math.min(Math.max(0, livePhaseDoneIdx + 1), totalPhases);
  }, [status, totalPhases, livePhaseDoneIdx]);

  const reviewOnly = useMemo(() => isReviewOnlyTemplate(template), [template]);
  const enrichedRounds = useMemo<RoundSnapshot[]>(
    () => enrichRounds(rounds, template, participantWarnings),
    [rounds, template, participantWarnings],
  );

  const latestRound = enrichedRounds[enrichedRounds.length - 1];
  const olderRounds = enrichedRounds.slice(0, -1);

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur-sm px-4 py-2 sm:px-8">
        <div className="flex w-full items-center gap-3">
          <Link
            href="/runs"
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden sm:inline">{projectName ?? "Runs"}</span>
          </Link>

          {/* Status dot — text label dropped as redundant with the
              phase stepper. Tooltip carries the long form for screen
              readers / hover. */}
          <span
            title={meta.text}
            className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_COLOR[meta.color]} ${
              isTerminal ? "" : "animate-pulse-soft"
            }`}
          />

          <div className="min-w-0 flex-1">
            <BriefHeading work={work} />
          </div>

          <HeaderActions
            chatId={chatId}
            status={status}
            isTerminal={isTerminal}
            template={template}
            onCancel={() => setStatus("cancelled")}
          />
        </div>
      </div>

      <PhaseProgress
        template={template}
        status={status}
        totalPhases={totalPhases}
        completedPhaseCount={completedPhaseCount}
        rounds={rounds}
        enrichedRounds={enrichedRounds}
        prUrl={prUrl}
        shipError={shipError}
      />

      {/* Body — full-width container. Reviewer outputs are text-heavy
          and benefit from the extra horizontal space. The 6xl cap was
          inherited from a marketing-style layout that doesn't fit a
          tool surface. */}
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

          {/* Review-only chats are single-pass by design — there is
              never an "earlier rounds" panel because there's exactly
              one round. */}
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
