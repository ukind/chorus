"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  Plug,
  Sparkles,
  Settings,
  CreditCard,
  Plus,
} from "lucide-react";
import {
  PROJECTS,
  TASKS_BY_PROJECT,
  BLOCKED_CHATS,
  type TaskRun,
} from "@/lib/mock-data";
import { ProjectSwitcher } from "./project-switcher";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  notification?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/templates", label: "Templates", icon: Layers, badge: "5" },
  {
    href: "/connect",
    label: "Connect",
    icon: Plug,
    notification: BLOCKED_CHATS.length > 0,
  },
];

const FOOTER_NAV: NavItem[] = [
  { href: "/credits", label: "Credits", icon: CreditCard, badge: "$12.40" },
  { href: "/settings", label: "Settings", icon: Settings },
];

const STATUS_DOT: Record<TaskRun["status"], string> = {
  running: "bg-primary animate-pulse-soft",
  done: "bg-emerald-400",
  "needs-review": "bg-amber-400",
  failed: "bg-destructive",
};

/**
 * Derive the "active project" from the current URL.
 * - /projects/<id>           → that project
 * - /runs/<runId>            → the project that owns that run
 * - everything else          → first project (Aurora) as default
 */
function useActiveProjectId(): string | null {
  const pathname = usePathname();
  // /projects/<id>
  const projMatch = pathname.match(/^\/projects\/([^/]+)/);
  if (projMatch) return projMatch[1];
  // /runs/<id> → look up project from mock data
  const runMatch = pathname.match(/^\/runs\/([^/]+)/);
  if (runMatch) {
    for (const [pid, runs] of Object.entries(TASKS_BY_PROJECT)) {
      if (runs.some((r) => r.id === runMatch[1])) return pid;
    }
  }
  // Default
  return PROJECTS[0]?.id ?? null;
}

interface SidebarBodyProps {
  onNavigate?: () => void;
}

/**
 * Inner sidebar content — used by both the desktop fixed sidebar
 * and the mobile Sheet overlay (see MobileNav).
 */
export function SidebarBody({ onNavigate }: SidebarBodyProps) {
  const pathname = usePathname();
  const activeProjectId = useActiveProjectId();
  const activeChats = activeProjectId
    ? (TASKS_BY_PROJECT[activeProjectId] ?? [])
    : [];

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

      {/* Project switcher */}
      <ProjectSwitcher activeProjectId={activeProjectId} />

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
                  {item.notification && (
                    <span
                      className="ml-auto flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300"
                      title={`${BLOCKED_CHATS.length} chat(s) awaiting your input`}
                    >
                      <span className="h-1 w-1 rounded-full bg-amber-400 animate-pulse-soft" />
                      {BLOCKED_CHATS.length}
                    </span>
                  )}
                  {item.badge && !item.notification && (
                    <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {item.badge}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Project-scoped chats list */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        <div className="flex items-center justify-between px-4 pb-1.5 pt-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Chats
          </span>
          <Link
            href="/new"
            onClick={onNavigate}
            className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            title="New chat"
          >
            <Plus className="h-3.5 w-3.5" />
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {activeChats.length === 0 ? (
            <div className="px-2 py-4 text-xs text-muted-foreground">
              No chats yet in this project.{" "}
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
              {activeChats.map((c) => {
                const href = `/runs/${c.id}`;
                const active = pathname === href;
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
                      <span className="line-clamp-2 leading-snug">
                        {c.title}
                      </span>
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
                  {item.badge && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {item.badge}
                    </span>
                  )}
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
