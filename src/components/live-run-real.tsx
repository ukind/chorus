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
  Pause,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { PhaseStepper, type PhaseState } from "@/components/phase-stepper";
import type { Template, ReviewerLineage } from "@/lib/types";
import type { TemplatePhase as MockTemplatePhase } from "@/lib/mock-data";

interface ParticipantSnapshot {
  participant: string; // dir name e.g. "doer-claude-code", "reviewer-codex-cli-0"
  role: "doer" | "reviewer";
  agentName: string; // e.g. "claude-code", "codex-cli"
  lineage: ReviewerLineage;
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[]; // first 4 lines of the answer for the card stream area
}

interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

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
}

const LINEAGE_DOT: Record<string, string> = {
  claude: "bg-violet-400",
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  kimi: "bg-pink-400",
};

const LINEAGE_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  kimi: "Kimi",
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  drafting: { text: "DRAFTING · doer working", color: "primary" },
  reviewing: { text: "REVIEWING · cross-lineage check", color: "primary" },
  approved: { text: "APPROVED", color: "emerald" },
  merged: { text: "MERGED · PR opened", color: "emerald" },
  blocked: { text: "BLOCKED · ship error", color: "amber" },
  no_review: { text: "NO REVIEW · reviewers unavailable", color: "amber" },
  failed: { text: "FAILED", color: "destructive" },
  cancelled: { text: "CANCELLED", color: "muted" },
};

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
    | "chat_done";
  payload: Record<string, unknown>;
  ts: number;
}

/** Build the participant key the run page uses for matching SSE events
 * to participant cards. Mirrors the directory-name suffix logic. */
function participantKey(role: string, lineage: string): string {
  return `${role}:${lineage}`;
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
}: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [rounds, setRounds] = useState<RoundSnapshot[]>(initialRounds);
  const [activeParticipants, setActiveParticipants] = useState<Set<string>>(
    new Set(),
  );
  const [prUrl, setPrUrl] = useState<string | undefined>(initialPrUrl);
  const [shipError, setShipError] = useState<string | undefined>(initialShipError);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  // Live tail per participant (role:lineage → most recent ~500 chars). When
  // headless transport is in use, runner emits phase_progress events with
  // payload.output containing the latest accumulated tail. We render this
  // immediately for instant feedback, falling back to disk-polled content
  // when the SSE event hasn't arrived yet.
  const [liveTails, setLiveTails] = useState<Record<string, string>>({});

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
    const id = setInterval(refresh, 4000);
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
            // Map agent label (e.g. "claude-code", "gemini-cli") back to
            // lineage. The phase_progress payload uses the shim name; we
            // map by prefix because dir names embed the agent name fully.
            const lineage = agent.split("-")[0];
            const key = participantKey(role, lineage);
            setLiveTails((prev) => ({ ...prev, [key]: output }));
          }
        }

        if (e.type === "phase_done" || e.type === "phase_failed") {
          // Clear actives — next phase_start re-populates.
          setActiveParticipants(new Set());
          // Don't clear liveTails — let the disk-poll update them with the
          // final answer instead of flashing empty.
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
    // Best-effort: if any active key matches role + agent prefix, mark active.
    for (const k of activeParticipants) {
      if (k.startsWith(`${p.role}-${p.lineage}-`) || k.startsWith(`${p.role}-${p.agentName}-`)) {
        return true;
      }
    }
    return false;
  };

  const meta = STATUS_LABEL[status] ?? { text: status.toUpperCase(), color: "muted" };
  const totalPhases = template?.phases?.length ?? 1;
  // Best-effort phase count: rounds with at least one done participant.
  const completedPhaseCount = useMemo(
    () =>
      rounds.length > 0 && rounds[rounds.length - 1].participants.some((p) => p.hasAnswer)
        ? Math.min(rounds.length, totalPhases)
        : 0,
    [rounds, totalPhases],
  );

  // Find the most recent round to show prominently. Older rounds collapse below.
  const latestRound = rounds[rounds.length - 1];
  const olderRounds = rounds.slice(0, -1);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-border bg-card/30 px-4 py-5 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link
              href="/runs"
              className="flex items-center gap-1 transition hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              {projectName ?? "Runs"}
            </Link>
            <span>/</span>
            <span className="font-mono text-[10px]">{chatId}</span>
          </div>

          <div className="flex items-start justify-between gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${STATUS_DOT_COLOR[meta.color]} ${
                    isTerminal ? "" : "animate-pulse-soft"
                  }`}
                />
                <span
                  className={`text-xs font-medium uppercase tracking-wider ${STATUS_TEXT_COLOR[meta.color]}`}
                >
                  {meta.text}
                </span>
                {template?.name && (
                  <Badge
                    variant="outline"
                    className="border-border font-mono text-[10px]"
                  >
                    {template.name}
                  </Badge>
                )}
              </div>
              <h1 className="mt-2 break-words text-xl font-semibold tracking-tight">
                {work}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={isTerminal}
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </button>
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
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Delete this chat? Removes the row, phase events, and the on-disk artifacts directory. Cannot be undone.",
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
                      window.alert("Delete failed. Daemon may be down.");
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

          {/* Progress strip */}
          <div className="flex items-center gap-4">
            <div className="flex flex-1 items-center gap-2">
              <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`transition-[width] duration-700 ease-out ${
                    status === "approved" ? "bg-emerald-400" : "bg-primary"
                  }`}
                  style={{
                    width: `${
                      (Math.max(completedPhaseCount, status === "approved" ? totalPhases : 0) /
                        totalPhases) *
                      100
                    }%`,
                  }}
                />
              </div>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {Math.min(completedPhaseCount, totalPhases)} / {totalPhases} phases
              </span>
            </div>
          </div>

          {/* Phase stepper — one button per template phase */}
          {template?.phases && template.phases.length > 0 && (
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
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-6xl space-y-8">
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
            />
          )}

          {olderRounds.length > 0 && (
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

function RoundView({
  round,
  isLatest,
  activeFor,
  liveTails,
}: {
  round: RoundSnapshot;
  isLatest?: boolean;
  activeFor: (p: ParticipantSnapshot) => boolean;
  liveTails: Record<string, string>;
}) {
  return (
    <section>
      <h2 className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
        Round {round.round}
        {isLatest && (
          <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            current
          </span>
        )}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {round.participants.map((p) => (
          <ParticipantCard
            key={p.participant}
            participant={p}
            isActive={activeFor(p)}
            liveTail={liveTails[`${p.role}:${p.lineage}`]}
          />
        ))}
      </div>
    </section>
  );
}

function ParticipantCard({
  participant,
  isActive,
  liveTail,
}: {
  participant: ParticipantSnapshot;
  isActive: boolean;
  liveTail?: string;
}) {
  const [showFull, setShowFull] = useState(false);

  const state: "working" | "done" | "idle" = participant.hasAnswer
    ? "done"
    : isActive || (liveTail && liveTail.length > 0)
      ? "working"
      : "idle";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border bg-card transition-colors ${
        state === "done"
          ? "border-emerald-500/30"
          : state === "working"
            ? "border-primary/40"
            : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${LINEAGE_DOT[participant.lineage] ?? "bg-muted"} ${
              state === "working" ? "animate-pulse-soft" : ""
            }`}
          />
          <span className="text-sm font-semibold capitalize">{participant.role}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {LINEAGE_LABEL[participant.lineage] ?? participant.lineage}
          </span>
        </div>
        <StateBadge state={state} />
      </div>

      <div className="flex-1 px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
        {participant.findingsPreview && participant.findingsPreview.length > 0 ? (
          participant.findingsPreview.map((line, i) => (
            <div key={i} className="py-0.5 text-foreground/90">
              {line}
            </div>
          ))
        ) : liveTail && liveTail.length > 0 ? (
          // Live tail from headless transport — last ~500 chars of streaming
          // output. Shows the agent typing in real time, no 4s polling lag.
          <pre className="whitespace-pre-wrap break-words text-foreground/85">
            {liveTail}
          </pre>
        ) : state === "working" ? (
          <div className="text-muted-foreground">Working…</div>
        ) : (
          <div className="text-muted-foreground/70">No output yet.</div>
        )}
      </div>

      {participant.answer && (
        <>
          <button
            type="button"
            onClick={() => setShowFull((s) => !s)}
            className="border-t border-border bg-card/40 px-4 py-2 text-left text-[10px] uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
          >
            {showFull ? "Hide full answer" : `Show full answer (${participant.answer.length.toLocaleString()} chars)`}
          </button>
          {showFull && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border bg-background px-4 py-3 text-xs leading-relaxed text-foreground">
              {participant.answer}
            </pre>
          )}
        </>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border bg-card/60 px-4 py-2 font-mono text-[10px] text-muted-foreground">
        <span>{participant.agentName}</span>
        <span>{participant.hasAnswer ? `${(participant.answer?.length ?? 0).toLocaleString()} B` : "—"}</span>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: "working" | "done" | "errored" | "idle" }) {
  switch (state) {
    case "done":
      return (
        <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
          <CheckCircle2 className="h-3 w-3" /> DONE
        </span>
      );
    case "errored":
      return (
        <span className="flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" /> ERRORED
        </span>
      );
    case "working":
      return (
        <span className="flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          <Loader2 className="h-3 w-3 animate-spin" /> WORKING
        </span>
      );
    default:
      return (
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          IDLE
        </span>
      );
  }
}
