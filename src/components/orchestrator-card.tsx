"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Plug,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import {
  connectOrchestrator,
  type OrchestratorStatus,
  type OrchestratorName,
  DaemonError,
  updateSettings,
} from "@/lib/api";
import { listOpencodeModels, type OpencodeModelsResult } from "@/lib/api/orchestrators";
import {
  UI_LINEAGE_AVAILABLE_MODELS,
  UI_LINEAGE_DEFAULT_MODEL,
  type UILineage,
} from "@/lib/lineage-maps";
import { cn } from "@/lib/utils";

/**
 * One unified card per CLI on the /connect page. Combines:
 *   1. MCP wiring status + Connect button (the original OrchestratorCard
 *      content — this is what tells the user "chorus is reachable from
 *      Claude Code").
 *   2. Inline-expandable model picker (the ex-FleetCard pattern). Lists
 *      already-enabled models on the collapsed card; click to expand the
 *      checkbox grid; toggles save immediately.
 *
 * Replaces the previous two-section layout (Editors above, Models per CLI
 * below) which showed each CLI twice. OpenCode picker is gateway-grouped
 * + lazy-fetched via `opencode models`; everything else uses the curated
 * flat list from UI_LINEAGE_AVAILABLE_MODELS.
 */
interface Props {
  initial: OrchestratorStatus;
  initialEnabled: string[];
  uiLineage?: UILineage;
}

const ORCHESTRATOR_TO_UI: Record<string, UILineage> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  kimi: "kimi",
};

export function OrchestratorCard({ initial, initialEnabled, uiLineage }: Props) {
  const [status, setStatus] = useState<OrchestratorStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);

  // Per-CLI model picker state.
  const ui = uiLineage ?? ORCHESTRATOR_TO_UI[initial.name];
  const supportsModels = ui !== undefined;
  const [enabled, setEnabled] = useState<string[]>(initialEnabled);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // OpenCode-specific: live-fetched gateway-grouped model list.
  const isOpencode = ui === "opencode";
  const [opencodeModels, setOpencodeModels] = useState<OpencodeModelsResult | null>(null);
  const [opencodeError, setOpencodeError] = useState<string | null>(null);
  const [opencodeLoading, setOpencodeLoading] = useState(false);

  // Curated flat list for non-opencode lineages.
  const flatAvailable = ui && ui !== "opencode" ? UI_LINEAGE_AVAILABLE_MODELS[ui] : undefined;

  useEffect(() => {
    if (!open || !isOpencode || opencodeModels || opencodeLoading) return;
    setOpencodeLoading(true);
    setOpencodeError(null);
    listOpencodeModels()
      .then(setOpencodeModels)
      .catch((err) => {
        setOpencodeError(
          err instanceof DaemonError
            ? err.message
            : "Couldn't list OpenCode models. Run `opencode auth login`.",
        );
      })
      .finally(() => setOpencodeLoading(false));
  }, [open, isOpencode, opencodeModels, opencodeLoading]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await connectOrchestrator(status.name as OrchestratorName);
      setStatus(result.status);
      setJustConnected(result.added.length > 0);
    } catch (err) {
      setError(
        err instanceof DaemonError
          ? err.message
          : "Failed to connect — is the daemon running?",
      );
    } finally {
      setBusy(false);
    }
  };

  const persistEnabled = async (next: string[]) => {
    if (!ui) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ [`${ui}.enabled_models`]: next });
      setEnabled(next);
    } catch (err) {
      setSaveError(
        err instanceof DaemonError ? err.message : "Couldn't save. Is the daemon running?",
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleModel = (m: string) => {
    const next = enabled.includes(m) ? enabled.filter((x) => x !== m) : [...enabled, m];
    void persistEnabled(next);
  };

  const isConnected = status.connected;
  const partial = status.approvedTools > 0 && !isConnected;

  return (
    <div className="rounded-lg border border-border bg-gradient-to-br from-primary/5 via-card to-card">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{status.label}</h3>
              {isConnected ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                  <Check className="h-3 w-3" /> Connected
                </span>
              ) : partial ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                  {status.approvedTools}/{status.totalTools} tools approved
                </span>
              ) : status.supported ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Not connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Coming soon
                </span>
              )}
              {supportsModels && (
                <span className="text-[10px] text-muted-foreground">
                  · {enabled.length} model{enabled.length === 1 ? "" : "s"} enabled
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {status.note}
            </p>
            {supportsModels && enabled.length > 0 && (
              <p className="mt-2 truncate font-mono text-[11px] text-foreground/80" title={enabled.join(", ")}>
                {enabled.slice(0, 3).join(", ")}
                {enabled.length > 3 && ` +${enabled.length - 3} more`}
              </p>
            )}
            {isConnected && status.firstCallBehavior === "prompts_once" && (
              <p className="mt-2 text-[11px] text-amber-300/90">
                ⚠ First chorus.* call will show a one-time prompt — click "Always allow".
              </p>
            )}
            {isConnected && status.firstCallBehavior === "inherits_global" && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Whether tool calls prompt depends on your existing approval-policy setting.
              </p>
            )}
          </div>
        </div>

        {status.supported && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {justConnected && !error && (
              <p className="text-xs text-emerald-400">
                ✓ Done. Restart {status.label} for the change to take effect.
              </p>
            )}
            {error && (
              <p className="flex items-start gap-1 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {supportsModels && (
                <button
                  type="button"
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground transition hover:border-muted-foreground/30"
                >
                  Manage models
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform",
                      open && "rotate-180",
                    )}
                  />
                </button>
              )}
              <button
                type="button"
                onClick={connect}
                disabled={busy || (isConnected && !partial)}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {isConnected
                  ? "Already connected"
                  : partial
                    ? "Approve remaining tools"
                    : `Connect ${status.label}`}
              </button>
            </div>
          </div>
        )}
      </div>

      {open && supportsModels && (
        <div className="space-y-3 border-t border-border bg-card/50 p-4 sm:p-5">
          {saveError && <p className="text-[11px] text-destructive">{saveError}</p>}

          {isOpencode ? (
            <>
              {opencodeLoading && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Listing models from <code className="rounded bg-muted px-1">opencode models</code>…
                </div>
              )}
              {opencodeError && (
                <p className="text-[11px] text-destructive">{opencodeError}</p>
              )}
              {opencodeModels &&
                Object.entries(opencodeModels.gateways)
                  .filter(([gw]) => gw.startsWith("opencode"))
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([gateway, list]) => (
                    <div key={gateway} className="space-y-1">
                      <p className="text-[11px] font-mono text-muted-foreground/80">
                        {gateway}/
                      </p>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {list.map((m) => (
                          <ModelToggle
                            key={m}
                            label={m.slice(gateway.length + 1)}
                            value={m}
                            selected={enabled.includes(m)}
                            disabled={saving}
                            onClick={() => toggleModel(m)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
            </>
          ) : (
            flatAvailable && (
              <div className="grid grid-cols-1 gap-1">
                {flatAvailable.map((m) => (
                  <ModelToggle
                    key={m}
                    label={m}
                    value={m}
                    selected={enabled.includes(m)}
                    disabled={saving}
                    onClick={() => toggleModel(m)}
                  />
                ))}
              </div>
            )
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            Toggles save automatically. Templates and the New Chat dialog only offer
            models you&apos;ve enabled here.
          </p>
        </div>
      )}
    </div>
  );
}

interface ModelToggleProps {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

function ModelToggle({ label, value, selected, disabled, onClick }: ModelToggleProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={value}
      className={cn(
        "flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition disabled:opacity-60",
        selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border bg-card hover:border-muted-foreground/30 text-muted-foreground",
      )}
    >
      <div
        className={cn(
          "grid h-3 w-3 shrink-0 place-items-center rounded-sm border transition",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border",
        )}
      >
        {selected && <Check className="h-2 w-2" />}
      </div>
      <span className="truncate font-mono">{label}</span>
    </button>
  );
}

export function defaultEnabledFor(uiLineage: UILineage | undefined): string[] {
  if (!uiLineage) return [];
  const def = UI_LINEAGE_DEFAULT_MODEL[uiLineage];
  return def ? [def] : [];
}
