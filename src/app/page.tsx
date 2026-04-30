import Link from "next/link";
import { ArrowRight, Plus, Activity, Layers } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listChats, listTemplates, DaemonError } from "@/lib/api";

async function getHomePageData() {
  try {
    const [chats, templates] = await Promise.all([
      listChats({ limit: 10, status: "active" }),
      listTemplates(),
    ]);
    return { chats, templates, error: null };
  } catch (err) {
    const error =
      err instanceof DaemonError
        ? `Error: ${err.message}`
        : "Failed to load data";
    return { chats: [], templates: [], error };
  }
}

export default async function HomePage() {
  const { chats, templates, error } = await getHomePageData();
  const activeChats = chats.filter((c) => c.status === "drafting" || c.status === "reviewing");

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-8 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Make sure the Chorus daemon is running with <code>chorus start</code>
            </p>
          </div>
        )}

        <div className="mb-8">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Today
          </p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl tracking-tight">
            Many voices, one chorus.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What do you want a council of LLMs to look at today?
          </p>
        </div>

        <div className="mb-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            href="/new"
            className="group flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 p-4 transition hover:bg-primary/15"
          >
            <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/20 text-primary">
              <Plus className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium">New chat</div>
              <div className="text-xs text-muted-foreground">
                Paste a task, pick a template
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>

          {templates.slice(0, 3).map((t) => (
            <Link
              key={t.id}
              href={`/new?template=${t.id}`}
              className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-muted-foreground/30"
            >
              <div className="grid h-10 w-10 place-items-center rounded-md bg-muted text-muted-foreground">
                <Layers className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground line-clamp-1">
                  {t.description}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          ))}
        </div>

        <div className="mb-10 grid grid-cols-3 gap-3">
          <Card className="bg-card p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Active runs
            </div>
            <div className="mt-2 text-2xl font-semibold text-primary">
              {activeChats.length}
            </div>
          </Card>
          <Card className="bg-card p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <Layers className="h-3.5 w-3.5" />
              Templates
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">
              {templates.length}
            </div>
          </Card>
          <Card className="bg-card p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Total runs
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">
              {chats.length}
            </div>
          </Card>
        </div>

        {activeChats.length > 0 && (
          <section className="mb-10">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Active runs
              </h2>
              <Link
                href="/runs"
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                View all →
              </Link>
            </div>
            <div className="space-y-3">
              {activeChats.slice(0, 3).map((chat) => (
                <Link
                  key={chat.id}
                  href={`/runs/${chat.id}`}
                  className="group block rounded-lg border border-border bg-card p-5 transition hover:border-muted-foreground/30"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-primary animate-pulse-soft" />
                        <span className="text-xs font-medium uppercase tracking-wider text-primary">
                          {chat.status}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-border font-mono text-[10px]"
                        >
                          {chat.templateId}
                        </Badge>
                      </div>
                      <h3 className="mt-2 text-base font-semibold line-clamp-1">
                        {chat.work}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                        Chat {chat.id}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
