"use client";

/**
 * Personas page — browse the worldview prompts that drive `invoke_persona`.
 * Built-in library lives in `prompts/personas/*.md` and is seeded into the
 * `personas` table on every daemon boot. User-cloned rows are never
 * overwritten. The cockpit fetches both via GET /personas; full system_prompt
 * is loaded on demand when a persona is selected (GET /personas/:id).
 */

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { CodeBlock } from "@/components/code-block";
import { listPersonas, getPersona, DaemonError } from "@/lib/api";
import type { Persona } from "@/lib/api/personas";
import { lineageDot, lineageLabel } from "@/lib/lineage-maps";

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedFull, setSelectedFull] = useState<Persona | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  useEffect(() => {
    listPersonas()
      .then((rows) => {
        // Sort: built-ins first (alphabetical), then user-cloned (alphabetical).
        const sorted = [...rows].sort((a, b) => {
          if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
          return a.label.localeCompare(b.label);
        });
        setPersonas(sorted);
        if (sorted.length > 0) setSelectedId(sorted[0].id);
      })
      .catch((err) =>
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load personas",
        ),
      );
  }, []);

  // Fetch the full persona (with system_prompt) when selection changes.
  useEffect(() => {
    if (!selectedId) {
      setSelectedFull(null);
      return;
    }
    let cancelled = false;
    setLoadingFull(true);
    getPersona(selectedId)
      .then((p) => {
        if (cancelled) return;
        setSelectedFull(p);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedFull(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingFull(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading personas</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="Personas"
          title="Reviewer worldviews."
          subtitle={
            <>
              Each persona is a set of instructions that teaches the same model
              to look for different things. Same Claude or Codex, different
              worldview, wildly different findings. Use any of them via the{" "}
              <code className="font-mono text-foreground/80">invoke_persona</code> MCP
              tool from inside Claude Code, Cursor, Codex, or any editor with
              chorus wired up.
            </>
          }
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
          {/* Persona list */}
          <div className="flex min-w-0 flex-col gap-2">
            {personas.map((p) => {
              const isSelected = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`rounded-xl text-left transition ${
                    isSelected
                      ? "ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                >
                  <Card className="bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{p.label}</span>
                          {p.builtin ? (
                            <Badge
                              variant="outline"
                              className="border-border text-[10px]"
                            >
                              built-in
                            </Badge>
                          ) : (
                            <Badge className="bg-primary/15 text-[10px] text-primary">
                              user
                            </Badge>
                          )}
                          {p.recommended_lineage && (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${lineageDot(p.recommended_lineage)}`}
                              />
                              {lineageLabel(p.recommended_lineage)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {p.one_liner}
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                          id: {p.id}
                        </p>
                      </div>
                    </div>
                  </Card>
                </button>
              );
            })}
            {personas.length === 0 && (
              <Card className="bg-card p-4 text-center text-sm text-muted-foreground">
                No personas yet. Daemon may still be seeding — refresh in a
                second.
              </Card>
            )}
          </div>

          {/* System prompt preview */}
          {selectedFull ? (
            <CodeBlock
              filename={`${selectedFull.id}.md`}
              charCount={selectedFull.system_prompt?.length ?? 0}
              footer={
                <>
                  <span>
                    Invoke via{" "}
                    <code className="rounded bg-muted/40 px-1 font-mono text-[10px] text-foreground/80">
                      invoke_persona({`{ personaId: "${selectedFull.id}" }`})
                    </code>
                  </span>
                  {selectedFull.builtin && (
                    <span>
                      edit at{" "}
                      <code className="font-mono text-[10px]">
                        prompts/personas/{selectedFull.id}.md
                      </code>
                    </span>
                  )}
                </>
              }
            >
              {selectedFull.system_prompt ?? ""}
            </CodeBlock>
          ) : loadingFull ? (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p className="text-sm">Loading persona…</p>
            </Card>
          ) : (
            <Card className="bg-card p-4 text-center text-muted-foreground">
              <p className="text-sm">Select a persona to view its prompt.</p>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
