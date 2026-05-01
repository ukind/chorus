/**
 * Single source of truth for lineage display labels and colour swatches.
 *
 * Two parallel maps because the data flows from two directions:
 *   - Templates use the daemon-side YAML schema lineage names ("anthropic",
 *     "openai", "google", "opencode", "moonshot"). UI helpers translate
 *     these to the cockpit-side ReviewerLineage names ("claude", "codex",
 *     "gemini", "opencode", "kimi") via UI_LINEAGE_MAP / mapLineage.
 *   - Personas use the daemon-side names directly via recommended_lineage.
 *
 * Keep both maps keyed by the daemon-side names; let callers translate
 * inputs once at the boundary and look up via the canonical key.
 */

export type DaemonLineage =
  | "anthropic"
  | "openai"
  | "google"
  | "opencode"
  | "moonshot";

export const LINEAGE_LABEL: Record<DaemonLineage, string> = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
  opencode: "OpenCode",
  moonshot: "Kimi",
};

/** Tailwind background colour class for the small lineage dot indicator. */
export const LINEAGE_DOT: Record<DaemonLineage, string> = {
  anthropic: "bg-violet-400",
  openai: "bg-orange-400",
  google: "bg-blue-400",
  opencode: "bg-emerald-400",
  moonshot: "bg-pink-400",
};

/** Returns the human label for a lineage, falling back to the raw key. */
export function lineageLabel(lineage: string | undefined): string {
  if (!lineage) return "";
  return LINEAGE_LABEL[lineage as DaemonLineage] ?? lineage;
}

/** Returns the dot colour class, falling back to a neutral muted dot. */
export function lineageDot(lineage: string | undefined): string {
  if (!lineage) return "bg-muted";
  return LINEAGE_DOT[lineage as DaemonLineage] ?? "bg-muted";
}

/**
 * UI-side lineage names — used by cockpit components that operate on the
 * `ReviewerLineage` enum (claude/codex/gemini/opencode/kimi). Kept in sync
 * with the daemon-side maps above; the cockpit calls these directly without
 * a translation step.
 */
export type UILineage = "claude" | "codex" | "gemini" | "opencode" | "kimi";

export const UI_LINEAGE_LABEL: Record<UILineage, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  kimi: "Kimi",
};

export const UI_LINEAGE_DOT: Record<UILineage, string> = {
  claude: "bg-violet-400",
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  kimi: "bg-pink-400",
};

export function uiLineageLabel(lineage: string | undefined): string {
  if (!lineage) return "";
  return UI_LINEAGE_LABEL[lineage as UILineage] ?? lineage;
}

export function uiLineageDot(lineage: string | undefined): string {
  if (!lineage) return "bg-muted";
  return UI_LINEAGE_DOT[lineage as UILineage] ?? "bg-muted";
}
