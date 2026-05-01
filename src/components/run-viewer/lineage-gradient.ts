/**
 * Per-lineage card gradients.
 *
 * Each reviewer card has a subtle vertical gradient in the brand colour
 * fading to flat card bg. Set at 15% opacity after first round of UX
 * feedback called the original 7% gradient invisible. Keys are cockpit-
 * side ReviewerLineage names (claude/codex/gemini/opencode/kimi).
 */
export const LINEAGE_GRADIENT: Record<string, string> = {
  claude: "bg-gradient-to-b from-violet-500/15 to-card",
  codex: "bg-gradient-to-b from-orange-500/15 to-card",
  gemini: "bg-gradient-to-b from-blue-500/15 to-card",
  opencode: "bg-gradient-to-b from-emerald-500/15 to-card",
  kimi: "bg-gradient-to-b from-pink-500/15 to-card",
};
