"use client";

import { ArrowRight, Shuffle } from "lucide-react";
import { UI_LINEAGE_BRAND, type UILineage } from "@/lib/lineage-maps";
import { cn } from "@/lib/utils";
import type { FallbackSwap } from "./types";

const NEUTRAL_BRAND = {
  dot: "bg-muted-foreground/40",
  gradient: "bg-gradient-to-br from-muted/30 via-card to-card",
} as const;

function brandFor(lineage: string) {
  if (lineage in UI_LINEAGE_BRAND) {
    return UI_LINEAGE_BRAND[lineage as UILineage];
  }
  return NEUTRAL_BRAND;
}

/**
 * One card per fallback swap. Sits inline with the participant cards
 * in the round grid so the user can SEE that voice X exhausted and
 * voice Y took over — the failed voice's own card still shows its
 * failure state, this card narrates the substitution.
 *
 * Compact, single-purpose: from-lineage (with brand dot) → to-lineage
 * (with brand dot) + the human reason. No expandable body, no toggles.
 */
export function FallbackSwapCard({ swap }: { swap: FallbackSwap }) {
  const fromBrand = brandFor(swap.fromLineage);
  const toBrand = brandFor(swap.toLineage);
  const isCrossLineage = swap.reason === "lineage_fallback";

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-amber-500/40",
        "bg-gradient-to-br from-amber-500/10 via-card to-card",
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <Shuffle className="h-3.5 w-3.5 text-amber-300" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-amber-300">
          {isCrossLineage ? "Cross-lineage fallback" : "Model fallback"}
        </span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          step {swap.fallbackIdx + 1}
        </span>
      </div>

      <div className="space-y-3 border-t border-border bg-card/30 p-4">
        <div className="flex items-center gap-2 text-[12px]">
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", fromBrand.dot)}
          />
          <span className="font-medium text-muted-foreground line-through">
            {swap.fromLineage}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/70 line-through">
            {swap.fromModel}
          </span>
          <ArrowRight className="h-3 w-3 shrink-0 text-amber-300" />
          <span className={cn("h-2 w-2 shrink-0 rounded-full", toBrand.dot)} />
          <span className="font-medium text-foreground">{swap.toLineage}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {swap.toModel}
          </span>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {swap.fromLineage} <span className="font-mono">{swap.fromModel}</span>{" "}
          on slot{" "}
          <span className="font-mono text-foreground/80">{swap.agent}</span>{" "}
          {isCrossLineage ? "exhausted its chain" : "produced no answer"}.
          The runner switched to{" "}
          <span className="font-medium text-foreground">{swap.toLineage}</span>{" "}
          <span className="font-mono">{swap.toModel}</span> and continued the
          review with that voice. The card on the left for{" "}
          <span className="font-mono text-foreground/80">{swap.agent}</span>{" "}
          shows the actual answer that came back — its header still reads the
          original lineage so the slot identity stays stable across the run.
        </p>
      </div>
    </div>
  );
}
