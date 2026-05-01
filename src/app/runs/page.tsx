import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { listChats, DaemonError } from "@/lib/api";
import { chatDisplayTitle } from "@/lib/chat-title";

export const dynamic = "force-dynamic";


async function getChats() {
  try {
    const chats = await listChats({ limit: 50 });
    return { chats, error: null };
  } catch (err) {
    return {
      chats: [],
      error:
        err instanceof DaemonError ? err.message : "Failed to load chats",
    };
  }
}

export default async function RunsListPage() {
  const { chats, error } = await getChats();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="History"
          title="All chats"
          subtitle="Browse previous runs and their outcomes."
        />

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          {chats.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No chats yet. Start a new one!
              </p>
            </div>
          ) : (
            chats.map((chat) => (
              <Link
                key={chat.id}
                href={`/runs/${chat.id}`}
                className="group flex items-start justify-between gap-4 rounded-lg border border-border bg-card p-4 transition hover:border-muted-foreground/30 hover:bg-card/80"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {chat.status}
                    </span>
                    <Badge
                      variant="outline"
                      className="border-border font-mono text-[10px]"
                    >
                      {chat.templateId}
                    </Badge>
                  </div>
                  <h3 className="text-sm font-medium text-foreground line-clamp-1">
                    {chatDisplayTitle(chat.work)}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(chat.createdAt).toLocaleString()}
                  </p>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </AppShell>
  );
}
