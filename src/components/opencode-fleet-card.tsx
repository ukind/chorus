"use client";

/**
 * Inline-expandable OpenCode card for the home-page reviewer fleet.
 *
 * Shows count of currently-enabled models; clicking expands a panel with
 * the same gateway-grouped checkbox grid used during onboarding. Toggling
 * a model PUTs /settings immediately so the change is live without a save
 * button — feels like checkbox state in the OS, not form state.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, ChevronDown, Loader2, Check } from "lucide-react";
import { lineageDot } from "@/lib/lineage-maps";
import { listOpencodeModels, type OpencodeModelsResult } from "@/lib/api/orchestrators";
import { updateSettings, DaemonError } from "@/lib/api";
import { cn } from "@/lib/utils";

interface OpencodeFleetCardProps {
  health: {
    status: "healthy" | "quota_exhausted" | "auth_invalid" | "rate_limited" | "unknown";
    message?: string;
  };
  initialEnabled: string[];
}

export function OpencodeFleetCard({ health, initialEnabled }: OpencodeFleetCardProps) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<string[]>(initialEnabled);
  const [models, setModels] = useState<OpencodeModelsResult | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || models || loadingModels) return;
    setLoadingModels(true);
    setModelsError(null);
    listOpencodeModels()
      .then((res) => setModels(res))
      .catch((err) => {
        const message =
          err instanceof DaemonError
            ? err.message
            : "Couldn't list OpenCode models. Run `opencode auth login`.";
        setModelsError(message);
      })
      .finally(() => setLoadingModels(false));
  }, [open, models, loadingModels]);

  async function persist(next: string[]) {
    setSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ "opencode.enabled_models": next });
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
        <span className={`h-2 w-2 shrink-0 rounded-full ${lineageDot("opencode")}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">OpenCode</div>
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
        <div className="space-y-3 border-t border-border bg-card/50 p-3">
          {loadingModels && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Listing models from <code className="rounded bg-muted px-1">opencode models</code>…
            </div>
          )}

          {modelsError && <p className="text-[11px] text-destructive">{modelsError}</p>}
          {saveError && <p className="text-[11px] text-destructive">{saveError}</p>}

          {models && (
            <div className="space-y-3">
              {Object.entries(models.gateways)
                .filter(([gw]) => gw.startsWith("opencode"))
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([gateway, list]) => (
                  <div key={gateway} className="space-y-1">
                    <p className="text-[11px] font-mono text-muted-foreground/80">{gateway}/</p>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                      {list.map((m) => {
                        const sel = enabled.includes(m);
                        return (
                          <button
                            key={m}
                            type="button"
                            disabled={saving}
                            onClick={() => toggleModel(m)}
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
                Toggles save automatically. Templates and the New Chat dialog will only offer
                models you&apos;ve enabled here.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: OpencodeFleetCardProps["health"]["status"] }) {
  switch (status) {
    case "healthy":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          Healthy
        </span>
      );
    case "auth_invalid":
    case "quota_exhausted":
    case "rate_limited":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {status === "auth_invalid" ? "Auth broken" : status === "quota_exhausted" ? "Quota out" : "Rate-limited"}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Untested
        </span>
      );
  }
}
