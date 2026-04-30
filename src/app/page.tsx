import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Plus, Sparkles, Users } from "lucide-react";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

import {
  listChats,
  listTemplates,
  listSecrets,
  getSettings,
  DaemonError,
} from "@/lib/api";
import type { Chat, Template, Secret, Settings as SettingsType } from "@/lib/types";

interface HomeData {
  chats: Chat[];
  templates: Template[];
  secrets: Secret[];
  settings: SettingsType | null;
  error: string | null;
}

async function getHomePageData(): Promise<HomeData> {
  try {
    const [chats, templates, secrets, settings] = await Promise.all([
      listChats({ limit: 8 }),
      listTemplates(),
      listSecrets(),
      getSettings().catch(() => null),
    ]);
    return { chats, templates, secrets, settings, error: null };
  } catch (err) {
    const error =
      err instanceof DaemonError
        ? err.message
        : "Failed to reach the Chorus daemon.";
    return { chats: [], templates: [], secrets: [], settings: null, error };
  }
}

export default async function HomePage() {
  const { chats, templates, secrets, settings, error } = await getHomePageData();

  // First-run gate: redirect to /onboarding if user has no credentials
  // and hasn't explicitly marked the wizard as completed.
  const onboarded =
    Boolean(settings?.onboarded) || secrets.length > 0;
  if (!error && !onboarded) {
    redirect("/onboarding");
  }

  const hasChats = chats.length > 0;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        {error && (
          <div className="mb-8 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm font-medium text-destructive">
              Daemon unreachable
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error} Start it with <code>chorus start</code>.
            </p>
          </div>
        )}

        {!hasChats ? <EmptyHero /> : <ActiveHome chats={chats} />}

        {templates.length > 0 && (
          <section className="mt-12">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Start from a template
              </h2>
              <Link
                href="/templates"
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                Browse all →
              </Link>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.slice(0, 6).map((t) => (
                <Link
                  key={t.id}
                  href={`/new?template=${t.id}`}
                  className="group rounded-lg border border-border bg-card p-4 transition hover:border-muted-foreground/30"
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm font-medium">{t.name}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}

function EmptyHero() {
  return (
    <section className="rounded-xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6 sm:p-10">
      <div className="grid h-12 w-12 place-items-center rounded-lg bg-primary/15 text-primary">
        <Users className="h-6 w-6" />
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">
        Many voices, one chorus.
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
        Paste a task, pick a template, and watch 2–4 LLMs of different lineages
        peer-review the work before you ship.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/new"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Start your first run
        </Link>
        <Link
          href="/templates"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium transition hover:border-muted-foreground/30"
        >
          Browse templates
        </Link>
      </div>
    </section>
  );
}

interface ActiveHomeProps {
  chats: Chat[];
}

function ActiveHome({ chats }: ActiveHomeProps) {
  return (
    <>
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Today
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            What should the council look at?
          </h1>
        </div>
        <Link
          href="/new"
          className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 sm:self-auto"
        >
          <Plus className="h-4 w-4" />
          New chat
        </Link>
      </header>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent runs
          </h2>
          <Link
            href="/runs"
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            View all →
          </Link>
        </div>
        <div className="space-y-2">
          {chats.slice(0, 5).map((chat) => (
            <Link
              key={chat.id}
              href={`/runs/${chat.id}`}
              className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition hover:border-muted-foreground/30"
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor(chat.status)}`}
              />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-medium">{chat.work}</p>
                <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="uppercase tracking-wider">{chat.status}</span>
                  <span>·</span>
                  <span className="font-mono">{chat.templateId}</span>
                </p>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-foreground" />
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

function dotColor(status: Chat["status"]): string {
  switch (status) {
    case "drafting":
      return "bg-amber-400";
    case "reviewing":
      return "bg-primary animate-pulse-soft";
    case "approved":
      return "bg-emerald-400";
    case "merged":
      return "bg-emerald-500";
    case "blocked":
      return "bg-amber-500 animate-pulse-soft";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}
