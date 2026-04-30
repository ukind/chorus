"use client";

import { useState } from "react";
import { Check, Loader2, Plug, AlertTriangle } from "lucide-react";
import {
  connectOrchestrator,
  type OrchestratorStatus,
  type OrchestratorName,
  DaemonError,
} from "@/lib/api";

interface Props {
  initial: OrchestratorStatus;
}

export function OrchestratorCard({ initial }: Props) {
  const [status, setStatus] = useState<OrchestratorStatus>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);

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

  const isConnected = status.connected;
  const partial = status.approvedTools > 0 && !isConnected;

  return (
    <div className="rounded-lg border border-border bg-gradient-to-br from-primary/5 via-card to-card p-4 sm:p-5">
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
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {status.note}
          </p>
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
          <div className="sm:ml-auto">
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
  );
}
