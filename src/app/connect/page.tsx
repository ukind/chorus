import { AppShell } from "@/components/app-shell";
import {
  listOrchestrators,
  DaemonError,
  type OrchestratorStatus,
} from "@/lib/api";
import { OrchestratorCard } from "@/components/orchestrator-card";
import {
  UI_LINEAGE_DEFAULT_MODEL,
  type UILineage,
} from "@/lib/lineage-maps";
import { fetchFromDaemon } from "@/lib/api/client";

const ORCHESTRATOR_TO_UI: Record<string, UILineage> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  kimi: "kimi",
};

export const dynamic = "force-dynamic";

interface PageData {
  orchestrators: OrchestratorStatus[];
  settings: Record<string, unknown>;
  error: string | null;
}

async function getPageData(): Promise<PageData> {
  try {
    const [orchestrators, settings] = await Promise.all([
      listOrchestrators().catch(() => []),
      fetchFromDaemon<Record<string, unknown>>("/settings").catch(() => ({})),
    ]);
    return { orchestrators, settings, error: null };
  } catch (err) {
    return {
      orchestrators: [],
      settings: {},
      error:
        err instanceof DaemonError ? err.message : "Failed to reach the daemon",
    };
  }
}

export default async function ConnectPage() {
  const { orchestrators, settings, error } = await getPageData();

  function readEnabled(uiLineage: UILineage): string[] {
    const key = `${uiLineage}.enabled_models`;
    const raw = settings[key];
    if (Array.isArray(raw)) return raw as string[];
    const def = UI_LINEAGE_DEFAULT_MODEL[uiLineage];
    return def ? [def] : [];
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <section>
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Connect
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              CLIs &amp; voices
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Connect chorus to each editor (one-click MCP wiring) and pick
              which models from each CLI may run as voices. Toggles save
              automatically.
            </p>
          </div>

          {orchestrators.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 p-6 text-sm text-muted-foreground">
              Daemon unreachable — orchestrator status will appear once it&apos;s up.
            </div>
          ) : (
            <div className="space-y-3">
              {orchestrators.map((o) => {
                const ui = ORCHESTRATOR_TO_UI[o.name];
                return (
                  <OrchestratorCard
                    key={o.name}
                    initial={o}
                    uiLineage={ui}
                    initialEnabled={ui ? readEnabled(ui) : []}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
