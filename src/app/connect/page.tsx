import { AppShell } from "@/components/app-shell";
import {
  listOrchestrators,
  DaemonError,
  type OrchestratorStatus,
} from "@/lib/api";
import { OrchestratorCard } from "@/components/orchestrator-card";
import { OpencodeFleetCard } from "@/components/opencode-fleet-card";
import { LineageFleetCard } from "@/components/lineage-fleet-card";
import {
  UI_LINEAGE_AVAILABLE_MODELS,
  UI_LINEAGE_DEFAULT_MODEL,
  type UILineage,
} from "@/lib/lineage-maps";
import { fetchFromDaemon } from "@/lib/api/client";

export const dynamic = "force-dynamic";

interface CliHealth {
  lineage: string;
  status: "healthy" | "quota_exhausted" | "auth_invalid" | "rate_limited" | "unknown";
  message?: string;
}

interface PageData {
  orchestrators: OrchestratorStatus[];
  settings: Record<string, unknown>;
  healths: Record<string, CliHealth>;
  error: string | null;
}

async function getPageData(): Promise<PageData> {
  try {
    const [orchestrators, settings, healths] = await Promise.all([
      listOrchestrators().catch(() => []),
      fetchFromDaemon<Record<string, unknown>>("/settings").catch(() => ({})),
      fetchFromDaemon<CliHealth[]>("/cli/health").catch(() => []),
    ]);
    const healthByLineage: Record<string, CliHealth> = {};
    for (const h of healths) healthByLineage[h.lineage] = h;
    return { orchestrators, settings, healths: healthByLineage, error: null };
  } catch (err) {
    return {
      orchestrators: [],
      settings: {},
      healths: {},
      error:
        err instanceof DaemonError ? err.message : "Failed to reach the daemon",
    };
  }
}

const LINEAGE_TO_DAEMON: Record<UILineage, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  kimi: "moonshot",
};

const LINEAGE_LABEL: Record<UILineage, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  kimi: "Kimi CLI",
};

export default async function ConnectPage() {
  const { orchestrators, settings, healths, error } = await getPageData();

  function readEnabled(uiLineage: UILineage): string[] {
    const key = `${uiLineage}.enabled_models`;
    const raw = settings[key];
    if (Array.isArray(raw)) return raw as string[];
    const def = UI_LINEAGE_DEFAULT_MODEL[uiLineage];
    return def ? [def] : [];
  }

  function healthFor(uiLineage: UILineage) {
    const daemon = LINEAGE_TO_DAEMON[uiLineage];
    const h = healths[daemon] ?? healths[uiLineage];
    return {
      status: (h?.status ?? "unknown") as CliHealth["status"],
      message: h?.message,
    };
  }

  const opencodeEnabled = (() => {
    const raw = settings["opencode.enabled_models"];
    return Array.isArray(raw) ? (raw as string[]) : [];
  })();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <section className="mb-10">
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Editors
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Where Chorus is reachable
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              One-click pre-approval so the orchestrator you use stops asking
              before every Chorus tool call. Idempotent — safe to re-run.
            </p>
          </div>

          {orchestrators.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 p-6 text-sm text-muted-foreground">
              Daemon unreachable — orchestrator status will appear once it&apos;s up.
            </div>
          ) : (
            <div className="space-y-3">
              {orchestrators.map((o) => (
                <OrchestratorCard key={o.name} initial={o} />
              ))}
            </div>
          )}
        </section>

        {/* Models per CLI — same fleet-card pattern as the home page,
            mirrored here as the canonical place to manage which models
            chorus may use as voices. Toggles persist immediately. */}
        <section className="mb-10">
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Voices
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Models per CLI
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Click a card to expand. Templates and the New Chat dialog only
              offer models you&apos;ve enabled here.
            </p>
          </div>
          <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(["claude", "codex", "gemini", "kimi"] as const).map((ui) => {
              const available = UI_LINEAGE_AVAILABLE_MODELS[ui];
              if (!available) return null;
              return (
                <LineageFleetCard
                  key={ui}
                  lineage={LINEAGE_TO_DAEMON[ui]}
                  label={LINEAGE_LABEL[ui]}
                  settingsKey={`${ui}.enabled_models`}
                  available={available}
                  initialEnabled={readEnabled(ui)}
                  health={healthFor(ui)}
                />
              );
            })}
            <OpencodeFleetCard
              health={healthFor("opencode")}
              initialEnabled={opencodeEnabled}
            />
          </div>
        </section>

      </div>
    </AppShell>
  );
}
