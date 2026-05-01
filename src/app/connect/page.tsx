import { AlertCircle, Clock } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import {
  listBlocked,
  listOrchestrators,
  DaemonError,
  type OrchestratorStatus,
} from "@/lib/api";
import { OrchestratorCard } from "@/components/orchestrator-card";

export const dynamic = "force-dynamic";

interface PageData {
  blocked: Awaited<ReturnType<typeof listBlocked>>;
  orchestrators: OrchestratorStatus[];
  error: string | null;
}

async function getPageData(): Promise<PageData> {
  try {
    const [blocked, orchestrators] = await Promise.all([
      listBlocked().catch(() => []),
      listOrchestrators().catch(() => []),
    ]);
    return { blocked, orchestrators, error: null };
  } catch (err) {
    return {
      blocked: [],
      orchestrators: [],
      error:
        err instanceof DaemonError ? err.message : "Failed to reach the daemon",
    };
  }
}

export default async function ConnectPage() {
  const { blocked, orchestrators, error } = await getPageData();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
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

        <section>
          <div className="mb-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Inbox
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Waiting for your input
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Chats blocked on a question, awaiting your decision.
            </p>
          </div>

          {blocked.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 p-8 text-center">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No chats waiting for your input
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {blocked.map((chat) => (
                <Link
                  key={chat.id}
                  href={`/runs/${chat.id}`}
                  className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-4 py-3 transition hover:border-muted-foreground/30 hover:bg-card/60"
                >
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-1 text-sm font-medium text-foreground">
                      Chat {chat.id}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {chat.status} · template {chat.templateId}
                    </div>
                  </div>
                  <Badge variant="outline" className="border-border text-[10px]">
                    {chat.status}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
