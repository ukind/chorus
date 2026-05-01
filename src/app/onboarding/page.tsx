"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Check } from "lucide-react";
import { TriadLogo } from "@/components/triad-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { upsertSecret, updateSettings, DaemonError } from "@/lib/api";
import {
  updatePermissions,
  type SandboxProfile,
  detectInstalledClis,
  validateCliPath,
  type CliDetection,
  type DetectableCliId,
} from "@/lib/api/settings";
import {
  listOpencodeModels,
  type OpencodeModelsResult,
} from "@/lib/api/orchestrators";
import { cn } from "@/lib/utils";

interface CliRow {
  id: string;
  provider: string;
  label: string;
  hint: string;
}

interface ApiKeyRow {
  provider: string;
  label: string;
  placeholder: string;
}

const CLIS: CliRow[] = [
  {
    id: "claude-code",
    provider: "anthropic",
    label: "Claude Code",
    hint: "Anthropic — uses your existing Claude login",
  },
  {
    id: "codex-cli",
    provider: "openai",
    label: "Codex CLI",
    hint: "OpenAI — ChatGPT Plus/Pro subscription",
  },
  {
    id: "gemini-cli",
    provider: "google",
    label: "Gemini CLI",
    hint: "Google — uses your gcloud auth",
  },
  {
    id: "opencode-cli",
    provider: "opencode",
    label: "OpenCode",
    hint: "OpenCode Go — routes Kimi, DeepSeek, Grok",
  },
  {
    id: "kimi-cli",
    provider: "moonshot",
    label: "Kimi CLI",
    hint: "MoonshotAI — kimi-k2 plan",
  },
  {
    id: "cursor",
    provider: "cursor",
    label: "Cursor",
    hint: "Cursor IDE — invoke chorus from inside it",
  },
  {
    id: "windsurf",
    provider: "windsurf",
    label: "Windsurf",
    hint: "Windsurf IDE — invoke chorus from inside it",
  },
];

const API_KEYS: ApiKeyRow[] = [
  { provider: "anthropic", label: "Anthropic", placeholder: "sk-ant-..." },
  { provider: "openai", label: "OpenAI", placeholder: "sk-..." },
  { provider: "openrouter", label: "OpenRouter", placeholder: "sk-or-..." },
  { provider: "google", label: "Google AI", placeholder: "AIza..." },
  { provider: "xai", label: "xAI (Grok)", placeholder: "xai-..." },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [selectedClis, setSelectedClis] = useState<Set<string>>(new Set());
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [sandboxProfile, setSandboxProfile] = useState<SandboxProfile>("workspace");
  const [autoApprovePrompts, setAutoApprovePrompts] = useState<boolean>(true);
  const [networkAccess, setNetworkAccess] = useState<boolean>(false);
  const [detection, setDetection] = useState<Record<string, CliDetection>>({});
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set());
  const [manualPath, setManualPath] = useState<Record<string, string>>({});
  const [manualError, setManualError] = useState<Record<string, string>>({});
  const [manualBusy, setManualBusy] = useState<Set<string>>(new Set());

  // OpenCode model picker: lazily fetched the first time the user ticks
  // OpenCode AND the binary is installed. The user picks which subscription
  // models chorus should expose as voices; persisted under
  // `opencode.enabled_models` on submit.
  const [opencodeModels, setOpencodeModels] = useState<OpencodeModelsResult | null>(null);
  const [opencodeModelsError, setOpencodeModelsError] = useState<string | null>(null);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [selectedOpencodeModels, setSelectedOpencodeModels] = useState<Set<string>>(new Set());

  useEffect(() => {
    detectInstalledClis()
      .then((rows) => {
        const map: Record<string, CliDetection> = {};
        const preTick = new Set<string>();
        for (const row of rows) {
          map[row.id] = row;
          if (row.found) preTick.add(row.id);
        }
        setDetection(map);
        if (preTick.size > 0) setSelectedClis(preTick);
      })
      .catch(() => {
        // Detection is best-effort; if the daemon probe fails the user can
        // still tick boxes manually. No need to surface an error.
      });
  }, []);

  const toggleCli = (id: string) => {
    setSelectedClis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Lazy-fetch the OpenCode model list the first time the user ticks
  // OpenCode AND the binary is installed. Runs `opencode models` on the
  // daemon side and groups by gateway prefix.
  useEffect(() => {
    if (!selectedClis.has("opencode-cli")) return;
    if (!detection["opencode-cli"]?.found) return;
    if (opencodeModels || opencodeModelsLoading) return;
    setOpencodeModelsLoading(true);
    setOpencodeModelsError(null);
    listOpencodeModels()
      .then((res) => {
        setOpencodeModels(res);
        // Pre-select the fleet defaults (kimi + deepseek when present).
        setSelectedOpencodeModels((prev) => {
          if (prev.size > 0) return prev;
          return new Set(res.defaultPicks);
        });
      })
      .catch((err) => {
        const message =
          err instanceof DaemonError
            ? err.message
            : "Couldn't list OpenCode models. Is the CLI authed (run `opencode auth login`)?";
        setOpencodeModelsError(message);
      })
      .finally(() => setOpencodeModelsLoading(false));
  }, [selectedClis, detection, opencodeModels, opencodeModelsLoading]);

  const toggleOpencodeModel = (m: string) => {
    setSelectedOpencodeModels((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  const toggleManual = (id: string) => {
    setManualOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setManualError((prev) => ({ ...prev, [id]: "" }));
  };

  const submitManualPath = async (id: DetectableCliId) => {
    const value = (manualPath[id] || "").trim();
    if (!value) {
      setManualError((prev) => ({ ...prev, [id]: "Enter the full path to the CLI program (e.g. /usr/local/bin/claude)." }));
      return;
    }
    setManualBusy((prev) => new Set(prev).add(id));
    setManualError((prev) => ({ ...prev, [id]: "" }));
    try {
      const result = await validateCliPath(id, value);
      if (result.found) {
        setDetection((prev) => ({ ...prev, [id]: result }));
        setSelectedClis((prev) => new Set(prev).add(id));
        setManualOpen((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        setManualError((prev) => ({
          ...prev,
          [id]: "Couldn't run that path. Check it points to the actual binary.",
        }));
      }
    } catch {
      setManualError((prev) => ({
        ...prev,
        [id]: "Validation failed. Is the daemon running?",
      }));
    } finally {
      setManualBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const updateApiKey = (provider: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
  };

  const filledCount =
    selectedClis.size +
    Object.values(apiKeys).filter((v) => v.trim().length > 0).length;

  const handleSubmit = () => {
    setError(null);

    if (filledCount === 0) {
      setError("Pick at least one CLI or paste at least one API key to continue.");
      return;
    }

    startTransition(async () => {
      try {
        for (const cliId of selectedClis) {
          const cli = CLIS.find((c) => c.id === cliId);
          if (!cli) continue;
          await upsertSecret(cli.provider, {
            kind: "cli_subscription",
            value: cli.id,
            updatedAt: Date.now(),
          });
        }

        for (const [provider, value] of Object.entries(apiKeys)) {
          const trimmed = value.trim();
          if (!trimmed) continue;
          await upsertSecret(provider, {
            kind: "api_key",
            value: trimmed,
            updatedAt: Date.now(),
          });
        }

        await updatePermissions({
          sandboxProfile,
          autoApprovePrompts,
          networkAccess,
        });

        // Persist the user's OpenCode model picks (if any) so templates
        // and voice pickers downstream know which subscription models are
        // available. Empty array = user has OpenCode but didn't pick any
        // models — also valid (they may have selected only API keys).
        const opencodeModelsToSave = selectedClis.has("opencode-cli")
          ? Array.from(selectedOpencodeModels)
          : [];

        await updateSettings({
          onboarded: true,
          "opencode.enabled_models": opencodeModelsToSave,
        });
        router.push("/");
        router.refresh();
      } catch (err) {
        const message =
          err instanceof DaemonError
            ? err.message
            : "Could not save. Is the Chorus daemon running?";
        setError(message);
      }
    });
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/15 text-primary">
            <TriadLogo className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Welcome to Chorus
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Connect at least one model to begin
            </h1>
          </div>
        </div>

        <p className="mb-8 text-sm leading-relaxed text-muted-foreground">
          Chorus runs your prompt past 2–4 LLMs of different lineages and synthesises
          consensus. Pick the CLI subscriptions you already have, or paste API keys.
          You can change these later in Settings.
        </p>

        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            CLI subscriptions
          </h2>
          <div className="space-y-2">
            {CLIS.map((cli) => {
              const checked = selectedClis.has(cli.id);
              const probe = detection[cli.id];
              const detectable = cli.id !== "cursor" && cli.id !== "windsurf";
              const showManual = detectable && !probe?.found && manualOpen.has(cli.id);
              const isBusy = manualBusy.has(cli.id);

              return (
                <div key={cli.id} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => toggleCli(cli.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border p-4 text-left transition",
                      checked
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-card hover:border-muted-foreground/30",
                    )}
                  >
                    <div
                      className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded border transition",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span>{cli.label}</span>
                        {probe?.found && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-500">
                            installed
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {probe?.found && probe.path ? probe.path : cli.hint}
                      </div>
                    </div>
                  </button>

                  {detectable && !probe?.found && (
                    <div className="pl-8">
                      <button
                        type="button"
                        onClick={() => toggleManual(cli.id)}
                        className="text-[11px] text-muted-foreground hover:text-foreground transition"
                      >
                        {showManual ? "Cancel" : "Don't see it? Set path manually →"}
                      </button>
                    </div>
                  )}

                  {showManual && (
                    <div className="ml-8 mt-1 space-y-2 rounded-md border border-border bg-card/50 p-3">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Paste the full path to the <code className="rounded bg-muted px-1">{
                          cli.id === "claude-code" ? "claude" :
                          cli.id === "codex-cli" ? "codex" :
                          cli.id === "gemini-cli" ? "gemini" :
                          cli.id === "opencode-cli" ? "opencode" :
                          "kimi"
                        }</code> binary. On macOS/Linux, run{" "}
                        <code className="rounded bg-muted px-1">which {
                          cli.id === "claude-code" ? "claude" :
                          cli.id === "codex-cli" ? "codex" :
                          cli.id === "gemini-cli" ? "gemini" :
                          cli.id === "opencode-cli" ? "opencode" :
                          "kimi"
                        }</code> in your terminal to find it. On Windows, use{" "}
                        <code className="rounded bg-muted px-1">where</code> instead.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={manualPath[cli.id] ?? ""}
                          onChange={(e) =>
                            setManualPath((prev) => ({ ...prev, [cli.id]: e.target.value }))
                          }
                          placeholder="/usr/local/bin/claude or C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd"
                          className="flex-1 font-mono text-xs"
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={isBusy}
                          onClick={() => submitManualPath(cli.id as DetectableCliId)}
                        >
                          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                        </Button>
                      </div>
                      {manualError[cli.id] && (
                        <p className="text-[11px] text-destructive">{manualError[cli.id]}</p>
                      )}
                      <details className="text-[11px] text-muted-foreground">
                        <summary className="cursor-pointer hover:text-foreground">
                          Not installed yet? How to add it to PATH
                        </summary>
                        <div className="mt-2 space-y-1 leading-relaxed">
                          <p>
                            <strong>macOS / Linux:</strong> add{" "}
                            <code className="rounded bg-muted px-1">export PATH="$HOME/.local/bin:$PATH"</code>{" "}
                            to <code>~/.zshrc</code> or <code>~/.bashrc</code>, then{" "}
                            <code className="rounded bg-muted px-1">source ~/.zshrc</code>.
                          </p>
                          <p>
                            <strong>Windows:</strong> Settings → System → About → Advanced system
                            settings → Environment Variables → edit <code>Path</code> for your user.
                          </p>
                          <p>After updating PATH, restart Chorus and re-run onboarding.</p>
                        </div>
                      </details>
                    </div>
                  )}

                  {cli.id === "opencode-cli" && checked && probe?.found && (
                    <div className="ml-8 mt-1 space-y-3 rounded-md border border-border bg-card/50 p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          Pick models to enable
                        </p>
                        <p className="text-[11px] text-muted-foreground/70">
                          {selectedOpencodeModels.size} selected
                        </p>
                      </div>

                      {opencodeModelsLoading && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Listing models from <code className="rounded bg-muted px-1">opencode models</code>…
                        </div>
                      )}

                      {opencodeModelsError && (
                        <p className="text-[11px] text-destructive">
                          {opencodeModelsError}
                        </p>
                      )}

                      {opencodeModels && (
                        <div className="space-y-3">
                          {Object.entries(opencodeModels.gateways)
                            .filter(([gw]) => gw.startsWith("opencode"))
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([gateway, models]) => (
                              <div key={gateway} className="space-y-1">
                                <p className="text-[11px] font-mono text-muted-foreground/80">
                                  {gateway}/
                                </p>
                                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                                  {models.map((m) => {
                                    const sel = selectedOpencodeModels.has(m);
                                    return (
                                      <button
                                        key={m}
                                        type="button"
                                        onClick={() => toggleOpencodeModel(m)}
                                        className={cn(
                                          "flex items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition",
                                          sel
                                            ? "border-primary/50 bg-primary/10 text-foreground"
                                            : "border-border bg-card hover:border-muted-foreground/30 text-muted-foreground",
                                        )}
                                      >
                                        <div
                                          className={cn(
                                            "grid h-3 w-3 shrink-0 place-items-center rounded-sm border transition",
                                            sel
                                              ? "border-primary bg-primary text-primary-foreground"
                                              : "border-border",
                                          )}
                                        >
                                          {sel && <Check className="h-2 w-2" />}
                                        </div>
                                        <span className="truncate font-mono">
                                          {m.slice(gateway.length + 1)}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                            Pre-selected: {opencodeModels.defaultPicks.join(", ") || "none — pick any model your subscription supports"}.
                            Change anytime in <code className="rounded bg-muted px-1">Settings → OpenCode</code>.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>API keys</span>
            <span className="font-normal normal-case text-muted-foreground/70">
              optional — paste only the ones you want to use
            </span>
          </h2>
          <Card className="divide-y divide-border bg-card p-0">
            {API_KEYS.map((row) => (
              <div
                key={row.provider}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
              >
                <label
                  htmlFor={`apikey-${row.provider}`}
                  className="w-full text-sm font-medium sm:w-32"
                >
                  {row.label}
                </label>
                <Input
                  id={`apikey-${row.provider}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={row.placeholder}
                  value={apiKeys[row.provider] ?? ""}
                  onChange={(e) => updateApiKey(row.provider, e.target.value)}
                  className="flex-1 font-mono text-xs"
                />
              </div>
            ))}
          </Card>
          <p className="mt-2 text-xs text-muted-foreground">
            Stored locally in <code>~/.chorus/chorus.db</code>. Never sent anywhere except the model provider you call.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Permissions &amp; sandbox
          </h2>
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
            Controls what reviewers can do on your machine. You can change this anytime in
            Settings &rarr; Permissions.
          </p>

          <div className="space-y-2">
            {(
              [
                {
                  id: "strict",
                  label: "Strict",
                  hint: "Read-only. Reviewers can inspect code but can't write files, exec shell, or hit the network.",
                },
                {
                  id: "workspace",
                  label: "Workspace (recommended)",
                  hint: "Read+write inside the chat dir, scoped shell, no network. Default for most teams.",
                },
                {
                  id: "full",
                  label: "Full access",
                  hint: "No sandbox at all. Only on a personal machine you fully trust.",
                },
              ] as const
            ).map((p) => {
              const checked = sandboxProfile === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSandboxProfile(p.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition",
                    checked
                      ? "border-primary/50 bg-primary/10"
                      : "border-border bg-card hover:border-muted-foreground/30",
                  )}
                >
                  <div
                    className={cn(
                      "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {p.hint}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-3 space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3">
              <input
                type="checkbox"
                checked={autoApprovePrompts}
                onChange={(e) => setAutoApprovePrompts(e.target.checked)}
                className="mt-1 h-4 w-4 cursor-pointer accent-primary"
              />
              <div className="min-w-0 flex-1 text-xs leading-relaxed">
                <div className="text-sm font-medium">Skip in-CLI permission prompts</div>
                <div className="mt-0.5 text-muted-foreground">
                  Passes <code className="rounded bg-muted px-1">--afk</code> /{" "}
                  <code className="rounded bg-muted px-1">auto_edit</code> to spawned reviewers
                  so they don't hang on per-tool prompts. Off = every action requires explicit
                  consent in the CLI's TUI.
                </div>
              </div>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3">
              <input
                type="checkbox"
                checked={networkAccess}
                onChange={(e) => setNetworkAccess(e.target.checked)}
                className="mt-1 h-4 w-4 cursor-pointer accent-primary"
              />
              <div className="min-w-0 flex-1 text-xs leading-relaxed">
                <div className="text-sm font-medium">Allow outbound network from reviewers</div>
                <div className="mt-0.5 text-muted-foreground">
                  Off by default. Templates that explicitly need network override per phase.
                </div>
              </div>
            </label>
          </div>
        </section>

        {error && (
          <div className="mb-6 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {filledCount === 0
              ? "Pick at least one to continue."
              : `${filledCount} ${filledCount === 1 ? "credential" : "credentials"} ready to save.`}
          </p>
          <Button
            onClick={handleSubmit}
            disabled={isPending || filledCount === 0}
            className="w-full sm:w-auto"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Get started
                <ArrowRight className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </main>
  );
}
