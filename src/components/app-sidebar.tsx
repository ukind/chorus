"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  Plug,
  Settings,
  Plus,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from "lucide-react";
import { TriadLogo } from "@/components/triad-logo";
import { listChats, DaemonError } from "@/lib/api";
import { chatDisplayTitle } from "@/lib/chat-title";
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
  { href: "/personas", label: "Personas", icon: Users },
  { href: "/connect", label: "Connect", icon: Plug },
];

const FOOTER_NAV: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
];

const STATUS_DOT: Record<Chat["status"], string> = {
  drafting: "bg-amber-400",
  reviewing: "bg-primary animate-pulse-soft",
  approved: "bg-emerald-400",
  no_review: "bg-amber-400",
  merged: "bg-emerald-500",
  blocked: "bg-amber-500 animate-pulse-soft",
  cancelled: "bg-muted-foreground",
  failed: "bg-destructive",
};

interface SidebarBodyProps {
  onNavigate?: () => void;
  /** True when sidebar is collapsed to icons-only (~56px wide). */
  collapsed?: boolean;
  /** Toggle collapsed state. Optional — undefined hides the toggle button. */
  onToggleCollapsed?: () => void;
}

/**
 * Inner sidebar content — used by both the desktop fixed sidebar
 * and the mobile Sheet overlay (see MobileNav).
 */
export function SidebarBody({ onNavigate, collapsed = false, onToggleCollapsed }: SidebarBodyProps) {
  const pathname = usePathname();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsState, setChatsState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  // Read the daemon version from /health on mount instead of hardcoding the
  // sidebar badge. Fixes a class of drift bug where bumping package.json +
  // CLI + daemon constants still left the cockpit showing the old version
  // because the literal in this file was never updated. /health is cached
  // for the session — single fetch on mount.
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/daemon/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const v = j?.data?.version ?? j?.version;
        if (typeof v === "string" && v.length > 0) setDaemonVersion(v);
      })
      .catch(() => {
        /* offline daemon — fall back to the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchChats = async () => {
      try {
        const list = await listChats({ limit: 12 });
        if (cancelled) return;
        setChats(list);
        setChatsState("ready");
      } catch (err) {
        if (cancelled) return;
        setChatsState(err instanceof DaemonError ? "error" : "error");
      }
    };

    // Initial fetch on mount + every pathname change.
    fetchChats();

    // Poll every 5s while the tab is visible. Pause when hidden so we
    // don't burn requests on a backgrounded tab. Resume + immediate
    // refresh on visibility-change so the sidebar reflects status updates
    // (drafting → reviewing → approved/merged) the user expects without a
    // manual page reload. Daemon list endpoint is cheap (single SQLite read).
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(fetchChats, 12000);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchChats();
        start();
      }
    };
    if (typeof document !== "undefined" && !document.hidden) {
      start();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      {/* Brand row — logo + name + version + collapse toggle. When collapsed,
          only the logo + toggle render so the row stays a single icon column. */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <TriadLogo className="h-[18px] w-[18px]" />
        </div>
        {!collapsed && (
          <>
            <span className="text-sm font-semibold tracking-tight">Chorus</span>
            <span className="ml-auto rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {daemonVersion ? `v${daemonVersion.replace(/^v/, "").replace(/-dev\.\d+$/, "")}` : "—"}
            </span>
          </>
        )}
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground",
              collapsed && "ml-auto",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Primary nav (global). Collapsed mode strips labels and tightens
          padding so each item is a square icon button. */}
      <nav className={cn("py-3", collapsed ? "px-1.5" : "px-2")}>
        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center rounded-md text-sm transition-colors",
                    collapsed ? "justify-center px-2 py-2" : "gap-2 px-2 py-1.5",
                    isActive(item.href)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Recent chats — Search + New chat sit ABOVE the scrollable list and
          stay sticky as the list grows. New chats appear at the top of the
          list (server returns chats ordered by created_at DESC). Hidden
          entirely in collapsed mode. */}
      {collapsed ? (
        <div className="min-h-0 flex-1" />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        {/* Sticky header: New chat + Recent label.
            Search button removed for v0.7 — it had no onClick and no
            backing API; clicking it would suggest a feature that doesn't
            exist. Lands in v0.8 with a Cmd+K modal. */}
        <div className="flex shrink-0 flex-col gap-2 bg-card/40 px-3 py-3">
          <Link
            href="/new"
            onClick={onNavigate}
            aria-label="New chat"
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New chat</span>
          </Link>
          <div className="mt-1 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {chatsState === "loading" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : chatsState === "error" ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              Can&apos;t reach Chorus. Try restarting it from your terminal:{" "}
              <code className="rounded bg-muted/40 px-1 font-mono text-[10px] text-foreground/80">
                chorus start
              </code>
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
                const href = `/runs/${c.slug || c.id}`;
                const active = pathname === href;
                const display = chatDisplayTitle(c.work);
                const title = display.length > 60 ? `${display.slice(0, 60)}…` : display;
                return (
                  <li key={c.id}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          STATUS_DOT[c.status],
                        )}
                      />
                      {/* Single-line clamp keeps each item glanceable. The
                       * 2-line wrap mode let multi-paragraph artifact prompts
                       * dominate the sidebar at 4-6 lines per row.
                       * `min-w-0` lets `truncate` shrink under the flex parent. */}
                      <span className="min-w-0 flex-1 truncate leading-snug" title={display}>
                        {title}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>
      )}

      {/* Footer nav (global) — same collapsed treatment as primary nav. */}
      <div className={cn("border-t border-border py-3", collapsed ? "px-1.5" : "px-2")}>
        <ul className="flex flex-col gap-0.5">
          {FOOTER_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center rounded-md text-sm transition-colors",
                    collapsed ? "justify-center px-2 py-2" : "gap-2 px-2 py-1.5",
                    isActive(item.href)
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
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
 *
 * Collapse state persists across reloads via localStorage. Width transitions
 * smoothly (200ms) for a Linear/Raycast feel.
 */
const COLLAPSED_KEY = "chorus.sidebar.collapsed";

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate from localStorage on mount. Default false (expanded) on first
  // visit so new users see the full sidebar before discovering the toggle.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(COLLAPSED_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      /* localStorage unavailable — fall through with default */
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside
      className={cn(
        "hidden h-screen shrink-0 flex-col border-r border-border bg-card/30 transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <SidebarBody collapsed={collapsed} onToggleCollapsed={toggle} />
    </aside>
  );
}
