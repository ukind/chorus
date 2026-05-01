/**
 * Reviewer-text → verdict heuristic.
 *
 * Reviewers don't return a structured boolean; they write English. This
 * tries to extract `approve / request-changes / null` from their final
 * answer.md, scanning the tail first (where verdicts typically live)
 * before falling back to the whole text. Word-boundary regex matches
 * avoid false positives like "approached" → approve.
 *
 * Returns:
 *   true   = reviewer approved
 *   false  = reviewer disagreed / requested changes
 *   null   = ambiguous (caller should treat as failed/inconclusive)
 *
 * The 80-char floor protects against `## DONE`-only answers being
 * counted as ambiguous-empty rather than auto-failures upstream.
 */
export function verdictFromReviewerText(content: string): boolean | null {
  const stripped = content.replace(/##\s*DONE\s*$/i, '').trim();
  if (stripped.length < 80) return null;

  const tail = stripped.slice(-400).toLowerCase();
  const negatives =
    /\b(request changes|requesting changes|disagree|reject(?:ed|ing)?|blocker|do not approve|do not merge|nack|cannot approve)\b/;
  const positives =
    /\b(approve(?:d|s)?|lgtm|looks good to me|no concerns|ship it|ack)\b/;

  if (negatives.test(tail)) return false;
  if (positives.test(tail)) return true;

  // Fall back to whole-text scan, but only let positives win when negatives
  // are truly absent — protects against an analytical review that mentions
  // "good practice" but ends with no explicit verdict.
  const whole = stripped.toLowerCase();
  if (negatives.test(whole)) return false;
  if (positives.test(whole)) return true;

  return null;
}
