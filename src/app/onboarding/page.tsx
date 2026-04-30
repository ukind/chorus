"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, ArrowRight, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { upsertSecret, updateSettings, DaemonError } from "@/lib/api";
import { updatePermissions, type SandboxProfile } from "@/lib/api/settings";
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

  const toggleCli = (id: string) => {
    setSelectedClis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

        await updateSettings({ onboarded: true });
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
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Welcome to Chorus
            </p>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
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
              return (
                <button
                  key={cli.id}
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
                    <div className="text-sm font-medium">{cli.label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {cli.hint}
                    </div>
                  </div>
                </button>
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
