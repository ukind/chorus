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
export type UILineage =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "kimi"
  | "openrouter";

export const UI_LINEAGE_LABEL: Record<UILineage, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  kimi: "Kimi",
  // Meta-lineage for HTTP-dispatched voices. The real underlying lineage
  // (anthropic/openai/google/etc.) is preserved on the voices table for
  // diversity scoring; this label is what the cockpit cards show because
  // the runner creates `reviewer-openrouter-N` dirs regardless of the
  // underlying model.
  openrouter: "OpenRouter",
};

export const UI_LINEAGE_DOT: Record<UILineage, string> = {
  claude: "bg-violet-400",
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  kimi: "bg-pink-400",
  openrouter: "bg-amber-400",
};

export function uiLineageLabel(lineage: string | undefined): string {
  if (!lineage) return "";
  return UI_LINEAGE_LABEL[lineage as UILineage] ?? lineage;
}

export function uiLineageDot(lineage: string | undefined): string {
  if (!lineage) return "bg-muted";
  return UI_LINEAGE_DOT[lineage as UILineage] ?? "bg-muted";
}

/**
 * Default model per UI lineage when a template's `models: []` is empty.
 * Mirrors the per-lineage defaults used by phase-editor and new-template-dialog;
 * lifted here so the run page can show the actual model on cards even when
 * the YAML omits it.
 */
export const UI_LINEAGE_DEFAULT_MODEL: Record<UILineage, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview",
  opencode: "kimi-k2.6",
  kimi: "kimi-k2.6",
  // No sensible default for openrouter — user explicitly selects a model.
  // Empty string lets `models?.[0] ?? defaultModel` resolve to "" which
  // the run page treats as "no model" (skips the · model · separator).
  openrouter: "",
};

/**
 * Curated model lists per CLI. Used by the home-page fleet cards so users
 * can pick which models they want chorus to expose as voices, the same way
 * the OpenCode card already does (just without gateway grouping — single
 * subscription per CLI, flat list).
 *
 * Update when a new model drops. Order = recommended first; the first
 * entry in each list is the canonical default and matches
 * UI_LINEAGE_DEFAULT_MODEL.
 *
 * OpenCode is omitted because it's discovered live via `opencode models`
 * (gateway-aware). Cursor/Windsurf are IDE orchestrators with no model
 * selection of their own.
 */
export const UI_LINEAGE_AVAILABLE_MODELS: Partial<Record<UILineage, string[]>> = {
  claude: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-5",
    "claude-sonnet-4",
  ],
  codex: [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.1",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3-flash",
    "gemini-2.5-pro",
  ],
  kimi: [
    "kimi-k2.6",
    "kimi-k2.5",
  ],
};

export function uiLineageDefaultModel(lineage: string | undefined): string | undefined {
  if (!lineage) return undefined;
  return UI_LINEAGE_DEFAULT_MODEL[lineage as UILineage];
}

/**
 * Per-CLI brand identity. ONE place to adjust colors so the violet=Claude,
 * blue=Gemini, etc. mapping never drifts across the run page, template
 * editor, sidebar, and connect surfaces. Add new CLIs here, not in callers.
 */
export interface LineageBrand {
  /** 400-shade for solid dots/swatches. */
  dot: string;
  /** 500-shade for ring/border accents. */
  ring: string;
  /** Subtle vertical gradient applied to participant cards. */
  gradient: string;
}

export const UI_LINEAGE_BRAND: Record<UILineage, LineageBrand> = {
  claude: {
    dot: "bg-violet-400",
    ring: "ring-violet-400/40",
    gradient: "bg-gradient-to-b from-violet-500/15 to-card",
  },
  codex: {
    dot: "bg-orange-400",
    ring: "ring-orange-400/40",
    gradient: "bg-gradient-to-b from-orange-500/15 to-card",
  },
  gemini: {
    dot: "bg-blue-400",
    ring: "ring-blue-400/40",
    gradient: "bg-gradient-to-b from-blue-500/15 to-card",
  },
  opencode: {
    dot: "bg-emerald-400",
    ring: "ring-emerald-400/40",
    gradient: "bg-gradient-to-b from-emerald-500/15 to-card",
  },
  kimi: {
    dot: "bg-pink-400",
    ring: "ring-pink-400/40",
    gradient: "bg-gradient-to-b from-pink-500/15 to-card",
  },
  openrouter: {
    dot: "bg-amber-400",
    ring: "ring-amber-400/40",
    gradient: "bg-gradient-to-b from-amber-500/15 to-card",
  },
};

export function uiLineageGradient(lineage: string | undefined): string {
  if (!lineage) return "bg-card";
  return UI_LINEAGE_BRAND[lineage as UILineage]?.gradient ?? "bg-card";
}
