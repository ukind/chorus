/**
 * Compact "fleet status" panel for the home page.
 *
 * Shows each connected CLI plus its current health (recorded by the runner
 * when error-detector fires). Tells the user at a glance:
 *   - which CLIs are wired up
 *   - which ones are quota-exhausted (and when they reset)
 *   - which ones are auth-broken
 *
 * Server component. Fetches both /orchestrators (connection state) and
 * /cli/health (recent failure state) and merges them.
 */

import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  CircleHelp,
  Plug,
} from "lucide-react";
import { fetchFromDaemon } from "@/lib/api/client";
import { lineageDot } from "@/lib/lineage-maps";
import Link from "next/link";

interface OrchestratorStatus {
  name: string;
  label: string;
  connected: boolean;
  supported: boolean;
}

interface CliHealth {
  lineage: string;
  status: "healthy" | "quota_exhausted" | "auth_invalid" | "rate_limited" | "unknown";
  message?: string;
  resetAt?: number;
  updatedAt: number;
}

// Map orchestrator name → underlying lineage tag for health lookup.
const ORCHESTRATOR_TO_LINEAGE: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  kimi: "moonshot",
};

function formatResetIn(resetAt?: number): string | null {
  if (!resetAt) return null;
  const ms = resetAt - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function statusBadge(health: CliHealth): React.ReactNode {
  switch (health.status) {
    case "quota_exhausted":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <Clock className="h-3 w-3" />
          Quota exhausted
          {health.resetAt && (
            <span className="ml-1 text-amber-200/70">
              {formatResetIn(health.resetAt)}
            </span>
          )}
        </span>
      );
    case "auth_invalid":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
          <AlertTriangle className="h-3 w-3" />
          Auth broken
        </span>
      );
    case "rate_limited":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <Clock className="h-3 w-3" />
          Rate-limited
        </span>
      );
    case "healthy":
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <CheckCircle2 className="h-3 w-3" />
          Healthy
        </span>
      );
    case "unknown":
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <CircleHelp className="h-3 w-3" />
          Untested
        </span>
      );
  }
}

export async function CliStatusPanel() {
  let orchestrators: OrchestratorStatus[] = [];
  let healths: CliHealth[] = [];
  try {
    orchestrators = await fetchFromDaemon<OrchestratorStatus[]>("/orchestrators");
  } catch {
    return null;
  }
  try {
    healths = await fetchFromDaemon<CliHealth[]>("/cli/health");
  } catch {
    healths = [];
  }

  const healthByLineage: Record<string, CliHealth> = {};
  for (const h of healths) healthByLineage[h.lineage] = h;

  const connectedOrchestrators = orchestrators.filter((o) => o.connected);

  if (connectedOrchestrators.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Reviewer fleet
        </h2>
        <Link
          href="/connect"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <Plug className="h-3 w-3" />
          Manage connections →
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {connectedOrchestrators.map((o) => {
          const lineage = ORCHESTRATOR_TO_LINEAGE[o.name] ?? o.name;
          const health = healthByLineage[lineage] ?? {
            lineage,
            status: "unknown" as const,
            updatedAt: 0,
          };
          return (
            <div
              key={o.name}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${lineageDot(lineage)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{o.label}</div>
                <div className="mt-0.5">{statusBadge(health)}</div>
                {health.message && health.status !== "healthy" && health.status !== "unknown" && (
                  <div className="mt-1 truncate text-[10px] text-muted-foreground">
                    {health.message}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
