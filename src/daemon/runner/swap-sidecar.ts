/**
 * Per-participant fallback-swap sidecar.
 *
 * Lives at `<participantDir>/_swaps.json` next to `answer.md` /
 * `_stats.json`. Mirrors the existing sidecar pattern — JSON, read by
 * the run-artifacts route at refresh time, no DB schema change.
 *
 * Why a sidecar and not the DB:
 *   - phase_events packs warnings as opaque text (`output: "[lineage_fallback]
 *     <message>"`). Reconstructing structured fromLineage/toModel/etc. on
 *     replay would mean parsing that string — fragile.
 *   - The SSE stream shuts off for terminal chats, so reload-after-done
 *     loses the cli_warning events entirely.
 *   - Sidecar survives indefinitely on disk and is cheap to read.
 *
 * Append-only — multiple swaps in a single slot's chain (rare, but
 * possible: codex → openrouter-gpt → claude) all land in one file.
 */

import fs from 'fs';
import path from 'path';

export interface SwapEntry {
  round: number;
  phaseId: string;
  role: 'doer' | 'reviewer';
  agent: string;
  reason: 'lineage_fallback' | 'model_fallback';
  fromLineage: string;
  toLineage: string;
  fromModel: string;
  toModel: string;
  fallbackIdx: number;
  ts: number;
}

const SIDECAR_NAME = '_swaps.json';

/**
 * Append a swap entry to the participant's sidecar. Reads the current
 * file (treats missing / malformed as empty), pushes the entry, writes
 * the result back. Synchronous + best-effort: a failed write is logged
 * to console.error and otherwise swallowed — the SSE event still went
 * out, so the live UI shows the swap; only the post-reload card is
 * affected.
 */
export function appendSwapSidecar(
  participantDir: string,
  entry: SwapEntry,
): void {
  try {
    const filePath = path.join(participantDir, SIDECAR_NAME);
    let existing: SwapEntry[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed as SwapEntry[];
      } catch {
        // Malformed file — drop and start fresh. Better than blocking the
        // append on a corrupt sidecar from a prior crash.
      }
    }
    existing.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
  } catch (err) {
    console.error(
      '[chorus] failed to write swap sidecar:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Read all swap entries from a participant's sidecar. Used by the
 * run-artifacts route to surface fallback swaps on the run page even
 * after the SSE stream has closed.
 */
export function readSwapSidecar(participantDir: string): SwapEntry[] {
  const filePath = path.join(participantDir, SIDECAR_NAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as SwapEntry[];
  } catch {
    /* malformed — treat as empty */
  }
  return [];
}
