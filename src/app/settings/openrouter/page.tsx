"use client";

/**
 * Add OpenRouter models to the voices catalog.
 *
 * Flow:
 *   1. User pastes their OpenRouter API key.
 *   2. Validate (live HTTP probe) → on success, save to daemon's secrets table.
 *   3. Fetch the model catalog (300+ models across providers).
 *   4. Filter by name/lineage; multi-select; "Add to voices" inserts each
 *      into the voices table as `provider=openrouter, source=api`.
 *
 * Note: this PR ships the catalog/insert flow only. Dispatching chat
 * completions to OpenRouter at runtime needs an HTTP shim (follow-up).
 * Voices added here will appear in the picker but selecting one in a
 * template won't run successfully until the shim lands. We surface this
 * caveat on the page so users aren't surprised.
 */

import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import {
  Check,
  Loader2,
  AlertTriangle,
  Search,
  ExternalLink,
  Info,
} from "lucide-react";
import {
  saveOpenRouterKey,
  listOpenRouterModels,
  addOpenRouterVoices,
  type OpenRouterModel,
} from "@/lib/api/openrouter";

type Status = "idle" | "validating" | "loading" | "ready" | "saving" | "saved";

export default function OpenRouterSettingsPage() {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{
    added: string[];
    skipped: string[];
  } | null>(null);

  async function validateAndSave() {
    setError(null);
    setResult(null);
    setStatus("validating");
    try {
      const v = await saveOpenRouterKey(apiKey.trim());
      if (!v.valid) {
        setError(v.error ?? "Validation failed");
        setStatus("idle");
        return;
      }
      setStatus("loading");
      const { models: list } = await listOpenRouterModels();
      // OpenRouter returns models in arbitrary order; sort alphabetically
      // so the picker is browsable. Lineage groups arrive separately
      // (anthropic/* clusters, openai/* clusters, etc.) which is fine.
      list.sort((a, b) => a.id.localeCompare(b.id));
      setModels(list);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }

  async function addPicked() {
    if (picked.size === 0) return;
    setError(null);
    setStatus("saving");
    try {
      const r = await addOpenRouterVoices(Array.from(picked));
      setResult(r);
      setPicked(new Set());
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("ready");
    }
  }

  const filtered = filter.trim()
    ? models.filter((m) =>
        m.id.toLowerCase().includes(filter.toLowerCase().trim()) ||
        m.name.toLowerCase().includes(filter.toLowerCase().trim()),
      )
    : models;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Settings"
        title="OpenRouter"
        subtitle="Paste your OpenRouter API key, pick which models you want as voices, save."
      />

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Card className="space-y-3 p-4">
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12px] text-emerald-200/90">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <div>
              Live dispatch — voices added here run via OpenRouter&apos;s
              chat-completions API. Costs come back per-call from the API
              and surface on the run page. Get a key at{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline hover:text-emerald-100"
              >
                openrouter.ai/keys
                <ExternalLink className="h-3 w-3" />
              </a>
              .
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              API Key
            </label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-or-v1-…"
                className="h-9 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm focus:border-primary/60 focus:outline-none"
                disabled={status === "validating" || status === "loading"}
              />
              <button
                type="button"
                onClick={validateAndSave}
                disabled={
                  apiKey.trim().length === 0 ||
                  status === "validating" ||
                  status === "loading"
                }
                className="flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-4 text-xs font-medium text-primary transition hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === "validating" || status === "loading" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {status === "validating" ? "Validating…" : "Loading…"}
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Validate &amp; save
                  </>
                )}
              </button>
            </div>
            {error && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {error}
              </div>
            )}
          </div>
        </Card>

        {(status === "ready" || status === "saving" || status === "saved") &&
          models.length > 0 && (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  Pick models ({models.length} available)
                </div>
                <button
                  type="button"
                  onClick={addPicked}
                  disabled={picked.size === 0 || status === "saving"}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary transition hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === "saving" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>Add {picked.size} to voices</>
                  )}
                </button>
              </div>

              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="filter by id or name…"
                  className="h-8 flex-1 bg-transparent text-xs focus:outline-none"
                />
                <span className="text-[10px] text-muted-foreground">
                  {filtered.length}/{models.length}
                </span>
              </div>

              {result && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12px] text-emerald-200">
                  Added {result.added.length} voice
                  {result.added.length === 1 ? "" : "s"}
                  {result.skipped.length > 0
                    ? ` · skipped ${result.skipped.length} (unknown id)`
                    : ""}
                </div>
              )}

              <div className="max-h-96 overflow-y-auto rounded-md border border-border">
                {filtered.map((m) => {
                  const checked = picked.has(m.id);
                  return (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-xs last:border-b-0 hover:bg-card/40"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(m.id);
                            else next.delete(m.id);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11px]">
                          {m.id}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {m.name}
                          {m.contextLength
                            ? ` · ${(m.contextLength / 1000).toFixed(0)}k ctx`
                            : ""}
                          {m.inputCostPerMtok !== undefined ||
                          m.outputCostPerMtok !== undefined
                            ? ` · ${formatPrice(m.inputCostPerMtok)}/${formatPrice(m.outputCostPerMtok)} per Mtok`
                            : ""}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </Card>
          )}
      </div>
    </AppShell>
  );
}

function formatPrice(usd?: number): string {
  if (usd === undefined) return "?";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
