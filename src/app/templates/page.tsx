"use client";

import { useState, useEffect } from "react";
import { GitFork, Heart, Code2, Eye } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NewTemplateDialog } from "@/components/new-template-dialog";
import { listTemplates, DaemonError } from "@/lib/api";
import { Template } from "@/lib/types";

const LINEAGE_DOT: Record<string, string> = {
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  claude: "bg-violet-400",
};

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "decide", label: "Decide" },
] as const;

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCat, setActiveCat] =
    useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    listTemplates()
      .then((temps) => {
        setTemplates(temps);
        if (temps.length > 0) setSelectedId(temps[0].id);
      })
      .catch((err) =>
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load templates",
        ),
      );
  }, []);

  const filtered =
    activeCat === "all"
      ? templates
      : templates.filter((t) => t.category === activeCat);

  const selected =
    templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading templates</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Templates
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Reusable workflows for the council.
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Each template defines the driver, reviewers, prompts, and quorum
              rule for a kind of task. Fork, edit, share.
            </p>
          </div>
          <NewTemplateDialog />
        </div>

        <div className="mb-4 flex items-center gap-1 border-b border-border">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCat(c.id)}
              className={`relative px-3 py-2 text-sm transition ${
                c.id === activeCat
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {c.label}
              {c.id === activeCat && (
                <span className="absolute inset-x-3 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
          {/* Template list */}
          <div className="flex flex-col gap-2">
            {filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={`rounded-xl text-left transition ${
                  t.id === selectedId
                    ? "ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                    : ""
                }`}
              >
                <Card className="bg-card p-4 transition group-hover:border-muted-foreground/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                          {t.name}
                        </span>
                        <Badge
                          variant="outline"
                          className="border-border text-[10px] capitalize"
                        >
                          {t.category}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {t.description}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                      {t.driver} →{" "}
                      <span className="flex items-center gap-1">
                        {t.phases[0]?.reviewer.candidates.map((l) => (
                          <span
                            key={l}
                            className={`h-1.5 w-1.5 rounded-full ${LINEAGE_DOT[l]}`}
                            title={l}
                          />
                        ))}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 font-mono">
                      <span className="flex items-center gap-1">
                        <GitFork className="h-3 w-3" />
                        {t.forks}
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart className="h-3 w-3" />
                        {t.popularity}
                      </span>
                    </div>
                  </div>
                </Card>
              </button>
            ))}
          </div>

          {/* YAML preview */}
          {selected ? (
            <Card className="bg-card p-0">
              <div className="flex items-center justify-between border-b border-border bg-card/60 px-4 py-2.5">
                <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <Code2 className="h-3 w-3" />
                  {selected.id}.yaml
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
                  >
                    <Eye className="h-3 w-3" />
                    Preview
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
                  >
                    <GitFork className="h-3 w-3" />
                    Fork
                  </button>
                </div>
              </div>
              <pre className="overflow-x-auto px-5 py-4 font-mono text-xs leading-relaxed text-muted-foreground">
                {selected.yaml}
              </pre>
              <div className="border-t border-border bg-card/60 px-4 py-2.5 text-[11px] text-muted-foreground">
                by {selected.authorHandle} · {selected.forks} forks ·{" "}
                {selected.popularity}% community love
              </div>
            </Card>
          ) : (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p>Select a template to view details</p>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
