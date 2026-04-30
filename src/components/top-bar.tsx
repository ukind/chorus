"use client";

import { Plus, Search, Command } from "lucide-react";
import Link from "next/link";
import { MobileNav } from "./mobile-nav";

export function TopBar() {
  return (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-background/60 px-4 backdrop-blur sm:gap-3 sm:px-6">
      <MobileNav />

      <div className="flex flex-1 items-center gap-2 min-w-0">
        <button
          type="button"
          className="flex h-9 w-full max-w-sm items-center gap-2 overflow-hidden rounded-md border border-border bg-card px-3 text-sm text-muted-foreground transition hover:border-muted-foreground/40 hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate whitespace-nowrap">Search…</span>
          <kbd className="ml-auto hidden shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:flex">
            <Command className="h-3 w-3" />K
          </kbd>
        </button>
      </div>

      <Link
        href="/new"
        aria-label="New chat"
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 sm:px-3"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">New chat</span>
      </Link>
    </header>
  );
}
