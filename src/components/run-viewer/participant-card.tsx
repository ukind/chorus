"use client";

import { useState } from "react";
import { uiLineageDot, uiLineageLabel } from "@/lib/lineage-maps";
import { LINEAGE_GRADIENT } from "./lineage-gradient";
import { StateBadge } from "./state-badge";
import type { ParticipantSnapshot, ParticipantState } from "./types";

/**
 * One reviewer/doer card in the run grid.
 *
 * Card state precedence (most-specific first):
 *   pending  — placeholder synthesised from template, no dir on disk yet
 *   done     — answer.md has non-empty content
 *   working  — chat is mid-run AND (proc is alive OR live tail has bytes)
 *   errored  — chat is in a terminal state but this participant produced 0 B
 *   idle     — fall-through (rare; shouldn't normally render)
 */
export function ParticipantCard({
  participant,
  isActive,
  liveTail,
  chatTerminal,
}: {
  participant: ParticipantSnapshot;
  isActive: boolean;
  liveTail?: string;
  /** Chat itself reached a terminal state — distinguishes "errored (no
   *  output produced even though run finished)" from "still working". */
  chatTerminal: boolean;
}) {
  const [showFull, setShowFull] = useState(false);

  // State precedence: pending (synthesised slot) → done (answer on disk) →
  // errored (chat terminal but no answer) → working (the implicit
  // non-terminal mid-flight state). Earlier code gated "working" on isActive
  // or liveTail bytes, but those signals lag behind phase_start replay and
  // would briefly flicker the card to "idle" — making it look frozen
  // between phase_start and the first text_delta. Anchoring on chat status
  // closes that window.
  const state: ParticipantState = participant.pending
    ? "pending"
    : participant.hasAnswer
      ? "done"
      : chatTerminal
        ? "errored"
        : "working";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border transition-[opacity,border-color,box-shadow] duration-300 ${
        LINEAGE_GRADIENT[participant.lineage] ?? "bg-card"
      } ${
        state === "done"
          ? "border-emerald-500/30"
          : state === "working"
            ? "border-primary/60 shadow-[0_0_0_1px_rgba(124,58,237,0.25),0_0_24px_-6px_rgba(124,58,237,0.45)] animate-pulse-soft"
            : state === "errored"
              ? "border-destructive/40"
              : state === "pending"
                ? "border-border/40 opacity-50 grayscale-[0.6]"
                : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm leading-none">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${uiLineageDot(participant.lineage)} ${
              state === "working" ? "animate-pulse-soft" : ""
            }`}
          />
          <span className="font-medium capitalize text-foreground">{participant.role}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {uiLineageLabel(participant.lineage)}
          </span>
          {participant.model && (
            <>
              <span className="text-muted-foreground/60">·</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {participant.model}
              </span>
            </>
          )}
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
        ) : state === "working" && liveTail && liveTail.length > 0 ? (
          // Live tail from headless transport — last ~500 chars of streaming
          // output. Gated on state==="working" so a stale tail keyed by
          // role:lineage (e.g. Round 1 reviewer's last text) can't leak
          // into a freshly-pending Round 2 reviewer card.
          <pre className="whitespace-pre-wrap break-words text-foreground/85">
            {liveTail}
          </pre>
        ) : state === "working" ? (
          <div className="text-muted-foreground">Thinking…</div>
        ) : state === "pending" ? (
          <div className="text-muted-foreground/70">Queued — runs after the doer.</div>
        ) : state === "errored" ? (
          <div className="text-destructive/80">
            The program finished but didn&apos;t produce any output.
          </div>
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
            {showFull
              ? "Hide full answer"
              : `Show full answer (${participant.answer.length.toLocaleString()} chars)`}
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
        <span>
          {participant.hasAnswer
            ? `${(participant.answer?.length ?? 0).toLocaleString()} B`
            : "—"}
        </span>
      </div>
    </div>
  );
}
