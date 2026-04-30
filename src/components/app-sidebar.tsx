"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  Plug,
  Sparkles,
  Settings,
  Plus,
  ListChecks,
} from "lucide-react";
import { listChats, DaemonError } from "@/lib/api";
import type { Chat } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/runs", label: "Runs", icon: ListChecks },
  { href: "/templates", label: "Templates", icon: Layers },
  { href: "/connect", label: "Connect", icon: Plug },
];

const FOOTER_NAV: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
];

const STATUS_DOT: Record<Chat["status"], string> = {
  drafting: "bg-amber-400",
  reviewing: "bg-primary animate-pulse-soft",
  approved: "bg-emerald-400",
  merged: "bg-emerald-500",
  blocked: "bg-amber-500 animate-pulse-soft",
  cancelled: "bg-muted-foreground",
  failed: "bg-destructive",
};

interface SidebarBodyProps {
  onNavigate?: () => void;
}

/**
 * Inner sidebar content — used by both the desktop fixed sidebar
 * and the mobile Sheet overlay (see MobileNav).
 */
export function SidebarBody({ onNavigate }: SidebarBodyProps) {
  const pathname = usePathname();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsState, setChatsState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listChats({ limit: 12 });
        if (cancelled) return;
        setChats(list);
        setChatsState("ready");
      } catch (err) {
        if (cancelled) return;
        setChatsState(err instanceof DaemonError ? "error" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Chorus</span>
        <span className="ml-auto rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          v0.5
        </span>
      </div>

      {/* Primary nav (global) */}
      <nav className="px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    isActive(item.href)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Recent chats list */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </span>
          <Link
            href="/new"
            onClick={onNavigate}
            className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="New chat"
            aria-label="New chat"
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {chatsState === "loading" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : chatsState === "error" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Daemon unreachable.
            </div>
          ) : chats.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              No chats yet.{" "}
              <Link
                href="/new"
                onClick={onNavigate}
                className="text-primary transition hover:underline"
              >
                Start one →
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {chats.map((c) => {
                const href = `/runs/${c.id}`;
                const active = pathname === href;
                const title = c.work.length > 60 ? `${c.work.slice(0, 60)}…` : c.work;
                return (
                  <li key={c.id}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                          STATUS_DOT[c.status],
                        )}
                      />
                      <span className="line-clamp-2 leading-snug">{title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>

      {/* Footer nav (global) */}
      <div className="border-t border-border px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {FOOTER_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    isActive(item.href)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/**
 * Desktop sidebar — hidden on mobile (md and up only).
 * Mobile users get the same content via MobileNav (Sheet overlay).
 */
export function AppSidebar() {
  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card/30 md:flex">
      <SidebarBody />
    </aside>
  );
}
