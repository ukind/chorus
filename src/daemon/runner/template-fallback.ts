/**
 * Template-level fallback chain.
 *
 * Per-slot fallback (`candidate.models[]`) handles "if claude-opus fails, try
 * claude-sonnet" — same lineage, same shim, same auth, just a different
 * `--model` argv.
 *
 * Template-level fallback (`template.fallback[]`) is the catch-all that fires
 * when ANY slot exhausts its per-slot chain. The user sets it once at the
 * template root, and chorus applies it to every slot whose lineage matches.
 *
 * Why same-lineage only:
 *   - Different lineages need a different shim, auth, on-disk dir, and
 *     event participant key. Cross-lineage swap-on-failure is a much bigger
 *     feature ("respawn this slot as a different lineage entirely") and
 *     out of scope for v0.7.
 *   - The user's example case is intra-lineage anyway (kimi + deepseek
 *     reviewers, both via opencode-go gateway, kimi as fallback).
 *
 * Strict (lineage, model) dedup:
 *   - Skip a fallback row that matches the slot's own current model — would
 *     just fail again.
 *   - Skip a fallback row that matches ANOTHER active slot in the same
 *     phase. The user's example: reviewers=[kimi, deepseek] + fallback=[kimi]
 *     should NOT spawn a second kimi reviewer when deepseek fails.
 */

interface SlotLike {
  /** Cockpit-side or daemon-side lineage — must compare apples to apples. */
  lineage: string;
  /** Index 0 holds the slot's primary model; subsequent are per-slot fallbacks. */
  models: string[];
}

interface FallbackRow {
  lineage: string;
  models: string[];
}

/**
 * Compose the slot's effective model chain by appending matching template
 * fallbacks (deduped) onto the slot's per-slot chain. The result is fed
 * directly into `runWithModelFallback` so no new runner code paths are
 * needed — template fallback piggybacks on the per-slot mechanism.
 *
 * Caller is responsible for passing a stable `lineage` value across all
 * slots and template-fallback rows (don't mix cockpit-side and daemon-side
 * names in the same call).
 *
 * @param slot          The slot whose chain we're building (its primary +
 *                      its per-slot fallbacks).
 * @param activeSlots   All slots in the same phase, including `slot`. Used
 *                      to dedup template fallbacks that would duplicate an
 *                      already-running voice.
 * @param templateFallback The template-root `fallback` array (or undefined).
 * @returns Extended model list — `slot.models` followed by deduped, same-
 *          lineage template fallbacks.
 */
export function buildSlotFallbackChain(
  slot: SlotLike,
  activeSlots: readonly SlotLike[],
  templateFallback: readonly FallbackRow[] | undefined,
): string[] {
  const chain = [...(slot.models ?? [])];
  if (!templateFallback || templateFallback.length === 0) return chain;

  // Pre-compute the dedup set: every (lineage, model) currently active in
  // this phase, plus the slot's per-slot fallbacks (so we don't re-emit
  // them via the template chain).
  const skipKeys = new Set<string>();
  for (const s of activeSlots) {
    for (const m of s.models ?? []) {
      skipKeys.add(`${s.lineage}:${m}`);
    }
  }

  for (const fb of templateFallback) {
    if (fb.lineage !== slot.lineage) continue; // out of scope for v0.7
    for (const m of fb.models ?? []) {
      const key = `${fb.lineage}:${m}`;
      if (skipKeys.has(key)) continue;
      skipKeys.add(key);
      chain.push(m);
    }
  }
  return chain;
}
