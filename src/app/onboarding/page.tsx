"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { TriadLogo } from "@/components/triad-logo";
import { Button } from "@/components/ui/button";
import {
  detectInstalledClis,
  validateCliPath,
  type CliDetection,
  type DetectableCliId,
  type SandboxProfile,
} from "@/lib/api/settings";
import {
  listOpencodeModels,
  type OpencodeModelsResult,
} from "@/lib/api/orchestrators";
import { ApiKeysSection } from "./api-keys-section";
import { CliSection } from "./cli-section";
import { PermissionsSection } from "./permissions-section";
import { describeError, submitOnboarding } from "./submit";

export default function OnboardingPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [selectedClis, setSelectedClis] = useState<Set<string>>(new Set());
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [sandboxProfile, setSandboxProfile] =
    useState<SandboxProfile>("workspace");
  const [autoApprovePrompts, setAutoApprovePrompts] = useState<boolean>(true);
  const [networkAccess, setNetworkAccess] = useState<boolean>(false);
  const [detection, setDetection] = useState<Record<string, CliDetection>>({});
  const [manualOpen, setManualOpen] = useState<Set<string>>(new Set());
  const [manualPath, setManualPath] = useState<Record<string, string>>({});
  const [manualError, setManualError] = useState<Record<string, string>>({});
  const [manualBusy, setManualBusy] = useState<Set<string>>(new Set());

  // OpenCode model picker: lazily fetched the first time the user ticks
  // OpenCode AND the binary is installed. The user picks which
  // subscription models chorus should expose as voices; persisted in
  // submit.ts.
  const [opencodeModels, setOpencodeModels] = useState<OpencodeModelsResult | null>(
    null,
  );
  const [opencodeModelsError, setOpencodeModelsError] = useState<string | null>(null);
  const [opencodeModelsLoading, setOpencodeModelsLoading] = useState(false);
  const [selectedOpencodeModels, setSelectedOpencodeModels] = useState<Set<string>>(
    new Set(),
  );

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
        // Detection is best-effort; if the daemon probe fails the user
        // can still tick boxes manually. No need to surface an error.
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
    // Skip when we already succeeded, are mid-flight, OR previously
    // errored. Without the error check, finally() flipping loading=false
    // re-runs this effect (loading is in deps), which retries forever.
    if (opencodeModels || opencodeModelsLoading || opencodeModelsError) return;
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
        setOpencodeModelsError(
          err instanceof Error
            ? err.message
            : "Couldn't list OpenCode models. Is the CLI authed (run `opencode auth login`)?",
        );
      })
      .finally(() => setOpencodeModelsLoading(false));
  }, [
    selectedClis,
    detection,
    opencodeModels,
    opencodeModelsLoading,
    opencodeModelsError,
  ]);

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
      setManualError((prev) => ({
        ...prev,
        [id]:
          "Enter the full path to the CLI program (e.g. /usr/local/bin/claude).",
      }));
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
          [id]:
            "Couldn't run that path. Check it points to the actual binary.",
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
        await submitOnboarding({
          selectedClis,
          apiKeys,
          sandboxProfile,
          autoApprovePrompts,
          networkAccess,
          opencodeModels,
          selectedOpencodeModels,
        });
        router.push("/");
        router.refresh();
      } catch (err) {
        setError(describeError(err));
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
          Chorus runs your prompt past 2–4 LLMs of different lineages and
          synthesises consensus. Pick the CLI subscriptions you already have,
          or paste API keys. You can change these later in Settings.
        </p>

        <CliSection
          selectedClis={selectedClis}
          toggleCli={toggleCli}
          detection={detection}
          manualOpen={manualOpen}
          toggleManual={toggleManual}
          manualPath={manualPath}
          setManualPath={setManualPath}
          manualError={manualError}
          manualBusy={manualBusy}
          submitManualPath={submitManualPath}
          opencodeModels={opencodeModels}
          opencodeModelsError={opencodeModelsError}
          opencodeModelsLoading={opencodeModelsLoading}
          selectedOpencodeModels={selectedOpencodeModels}
          toggleOpencodeModel={toggleOpencodeModel}
        />

        <ApiKeysSection apiKeys={apiKeys} updateApiKey={updateApiKey} />

        <PermissionsSection
          sandboxProfile={sandboxProfile}
          setSandboxProfile={setSandboxProfile}
          autoApprovePrompts={autoApprovePrompts}
          setAutoApprovePrompts={setAutoApprovePrompts}
          networkAccess={networkAccess}
          setNetworkAccess={setNetworkAccess}
        />

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
