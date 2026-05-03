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
  reviewOnly,
  chatId,
}: {
  round: RoundSnapshot;
  isLatest?: boolean;
  activeFor: (p: ParticipantSnapshot) => boolean;
  liveTails: Record<string, string>;
  chatTerminal: boolean;
  /** Review-only chats hide the doer card and the "Round N" header — there
   *  is no doer to render, and the chat is single-pass. The participants
   *  list still arrives with a synthetic doer-artifact slot; we filter it
   *  out so the cockpit doesn't show "doer · pending" for the user's own
   *  artifact. */
  reviewOnly?: boolean;
  /** Threaded down so each card's per-participant cancel button can
   *  target the right chat. Optional for back-compat with any caller
   *  that doesn't yet plumb it; the card silently hides the button. */
  chatId?: string;
}) {
  const visibleParticipants = reviewOnly
    ? round.participants.filter((p) => p.role !== "doer")
    : round.participants;

  return (
    <section>
      {!reviewOnly && (
        <h2 className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
          Round {round.round}
          {isLatest && (
            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              current
            </span>
          )}
        </h2>
      )}
      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visibleParticipants.map((p) => (
          <ParticipantCard
            key={p.participant}
            participant={p}
            isActive={activeFor(p)}
            // Look up the live tail by the participant's directory-name
            // identity (`p.participant` is "reviewer-opencode-cli-1",
            // "reviewer-opencode-cli-2", etc.) — must match the key format
            // live-run-real builds in its phase_progress handler. The old
            // `role:lineage` key collided across same-lineage reviewers
            // and rendered one reviewer's stream in another's card.
            liveTail={liveTails[p.participant]}
            chatTerminal={chatTerminal}
            chatId={chatId}
            reviewOnly={reviewOnly}
          />
        ))}
      </div>
    </section>
  );
}
