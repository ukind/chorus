"use client";

import { ParticipantCard } from "./participant-card";
import type { ParticipantSnapshot, RoundSnapshot } from "./types";

/**
 * Single round of a chat — the doer card plus its reviewer cards.
 * Dropping the inline doer/reviewer split here was the cleanup that let
 * us extract this from the 880-line live-run-real monolith; both roles
 * land in `participants` with `role` set, and ParticipantCard renders
 * them uniformly.
 */
export function RoundView({
  round,
  isLatest,
  activeFor,
  liveTails,
  chatTerminal,
}: {
  round: RoundSnapshot;
  isLatest?: boolean;
  activeFor: (p: ParticipantSnapshot) => boolean;
  liveTails: Record<string, string>;
  chatTerminal: boolean;
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {round.participants.map((p) => (
          <ParticipantCard
            key={p.participant}
            participant={p}
            isActive={activeFor(p)}
            liveTail={liveTails[`${p.role}:${p.lineage}`]}
            chatTerminal={chatTerminal}
          />
        ))}
      </div>
    </section>
  );
}
