import { AlertCircle, Clock } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { listBlocked, DaemonError } from "@/lib/api";

async function getBlockedChats() {
  try {
    const chats = await listBlocked();
    return { chats, error: null };
  } catch (err) {
    return {
      chats: [],
      error:
        err instanceof DaemonError ? err.message : "Failed to load blocked chats",
    };
  }
}

export default async function ConnectPage() {
  const { chats: blockedChats, error } = await getBlockedChats();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Inbox
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Waiting for your input
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Chats that are blocked, awaiting your decision before they proceed.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {blockedChats.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/30 p-8 text-center">
            <AlertCircle className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              No chats waiting for your input
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {blockedChats.map((chat) => (
              <Link
                key={chat.id}
                href={`/runs/${chat.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-4 py-3 transition hover:border-muted-foreground/30 hover:bg-card/60"
              >
                <Clock className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground line-clamp-1">
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
      </div>
    </AppShell>
  );
}
