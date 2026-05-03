"use client";

import { Check, Loader2 } from "lucide-react";
import type { OpencodeModelsResult } from "@/lib/api/orchestrators";
import { cn } from "@/lib/utils";

interface OpencodeModelPickerProps {
  loading: boolean;
  error: string | null;
  models: OpencodeModelsResult | null;
  selected: Set<string>;
  onToggle: (m: string) => void;
}

export function OpencodeModelPicker({
  loading,
  error,
  models,
  selected,
  onToggle,
}: OpencodeModelPickerProps) {
  return (
    <div className="ml-8 mt-1 space-y-3 rounded-md border border-border bg-card/50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Pick models to enable
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          {selected.size} selected
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Listing models from{" "}
          <code className="rounded bg-muted px-1">opencode models</code>…
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {models && (
        <div className="space-y-3">
          {Object.entries(models.gateways)
            .filter(([gw]) => gw.startsWith("opencode"))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([gateway, list]) => (
              <div key={gateway} className="space-y-1">
                <p className="text-[11px] font-mono text-muted-foreground/80">
                  {gateway}/
                </p>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {list.map((m) => {
                    const sel = selected.has(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => onToggle(m)}
                        className={cn(
                          "flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition",
                          sel
                            ? "border-primary/50 bg-primary/10 text-foreground"
                            : "border-border bg-card hover:border-muted-foreground/30 text-muted-foreground",
                        )}
                      >
                        <div
                          className={cn(
                            "grid h-3 w-3 shrink-0 place-items-center rounded-sm border transition",
                            sel
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border",
                          )}
                        >
                          {sel && <Check className="h-2 w-2" />}
                        </div>
                        <span className="truncate font-mono">
                          {m.slice(gateway.length + 1)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            Pre-selected: {models.defaultPicks.join(", ") || "none — pick any model your subscription supports"}.
            Change anytime in{" "}
            <code className="rounded bg-muted px-1">Settings → OpenCode</code>.
          </p>
        </div>
      )}
    </div>
  );
}
