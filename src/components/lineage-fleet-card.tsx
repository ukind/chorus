"use client";

/**
 * Inline-expandable fleet card for single-subscription CLIs (Claude Code,
 * Codex CLI, Gemini CLI, Kimi CLI). Shares the toggle UX of
 * OpencodeFleetCard but skips the gateway grouping — these CLIs back a
 * single subscription with a flat list of models.
 *
 * Settings key: `<lineage>.enabled_models` (e.g. "claude.enabled_models").
 * Each toggle PUTs settings immediately so changes are live without a
 * save button.
 */

import { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  CircleHelp,
  ChevronDown,
  Check,
} from "lucide-react";
import { lineageDot } from "@/lib/lineage-maps";
import { updateSettings, DaemonError } from "@/lib/api";
import { cn } from "@/lib/utils";

interface LineageFleetCardProps {
  /** Daemon-side lineage name — "anthropic", "openai", "google", "moonshot". */
  lineage: string;
  /** Display label — "Claude Code", "Codex CLI", etc. */
  label: string;
  /** Settings key for persisting the user's choice. */
  settingsKey: string;
  /** All models the user could enable. */
  available: string[];
  /** Current enabled subset. */
  initialEnabled: string[];
  health: {
    status: "healthy" | "quota_exhausted" | "auth_invalid" | "rate_limited" | "unknown";
    message?: string;
  };
}

export function LineageFleetCard({
  lineage,
  label,
  settingsKey,
  available,
  initialEnabled,
  health,
}: LineageFleetCardProps) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<string[]>(initialEnabled);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function persist(next: string[]) {
    setSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ [settingsKey]: next });
      setEnabled(next);
    } catch (err) {
      const message =
        err instanceof DaemonError ? err.message : "Couldn't save. Is the daemon running?";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  function toggleModel(m: string) {
    const next = enabled.includes(m) ? enabled.filter((x) => x !== m) : [...enabled, m];
    void persist(next);
  }

  return (
    <div className="rounded-lg border border-border bg-card transition-colors hover:border-foreground/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${lineageDot(lineage)}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-0.5 flex items-center gap-2">
            <StatusBadge status={health.status} />
            <span className="text-[10px] text-muted-foreground">
              {enabled.length} model{enabled.length === 1 ? "" : "s"} enabled
            </span>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-2 border-t border-border bg-card/50 p-3">
          {saveError && <p className="text-[11px] text-destructive">{saveError}</p>}
          <div className="grid grid-cols-1 gap-1">
            {available.map((m) => {
              const sel = enabled.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  disabled={saving}
                  onClick={() => toggleModel(m)}
                  title={m}
                  className={cn(
                    "flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition disabled:opacity-60",
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
                  <span className="truncate font-mono">{m}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            Toggles save automatically. Model list is curated per chorus release —
            new models appear after upgrades.
          </p>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: LineageFleetCardProps["health"]["status"] }) {
  switch (status) {
    case "healthy":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          Healthy
        </span>
      );
    case "auth_invalid":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          Auth broken
        </span>
      );
    case "quota_exhausted":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          Quota out
        </span>
      );
    case "rate_limited":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <Clock className="h-3 w-3" />
          Rate-limited
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <CircleHelp className="h-3 w-3" />
          Untested
        </span>
      );
  }
}
