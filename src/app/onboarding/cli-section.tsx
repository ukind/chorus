"use client";

import { Check, Loader2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CliDetection,
  DetectableCliId,
} from "@/lib/api/settings";
import type { OpencodeModelsResult } from "@/lib/api/orchestrators";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CLIS, manualBinaryName } from "./helpers.js";
import { OpencodeModelPicker } from "./opencode-model-picker.js";

interface CliSectionProps {
  selectedClis: Set<string>;
  toggleCli: (id: string) => void;
  detection: Record<string, CliDetection>;
  manualOpen: Set<string>;
  toggleManual: (id: string) => void;
  manualPath: Record<string, string>;
  setManualPath: Dispatch<SetStateAction<Record<string, string>>>;
  manualError: Record<string, string>;
  manualBusy: Set<string>;
  submitManualPath: (id: DetectableCliId) => void;

  opencodeModels: OpencodeModelsResult | null;
  opencodeModelsError: string | null;
  opencodeModelsLoading: boolean;
  selectedOpencodeModels: Set<string>;
  toggleOpencodeModel: (m: string) => void;
}

export function CliSection(props: CliSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        CLI subscriptions
      </h2>
      <div className="space-y-2">
        {CLIS.map((cli) => {
          const checked = props.selectedClis.has(cli.id);
          const probe = props.detection[cli.id];
          const detectable = cli.id !== "cursor" && cli.id !== "windsurf";
          const showManual =
            detectable && !probe?.found && props.manualOpen.has(cli.id);
          const isBusy = props.manualBusy.has(cli.id);

          return (
            <div key={cli.id} className="space-y-1">
              <button
                type="button"
                onClick={() => props.toggleCli(cli.id)}
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
                    onClick={() => props.toggleManual(cli.id)}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition"
                  >
                    {showManual ? "Cancel" : "Don't see it? Set path manually →"}
                  </button>
                </div>
              )}

              {showManual && (
                <ManualPath
                  cliId={cli.id}
                  value={props.manualPath[cli.id] ?? ""}
                  onChange={(v) =>
                    props.setManualPath((prev) => ({ ...prev, [cli.id]: v }))
                  }
                  error={props.manualError[cli.id]}
                  busy={isBusy}
                  onSubmit={() => props.submitManualPath(cli.id as DetectableCliId)}
                />
              )}

              {cli.id === "opencode-cli" && checked && probe?.found && (
                <OpencodeModelPicker
                  loading={props.opencodeModelsLoading}
                  error={props.opencodeModelsError}
                  models={props.opencodeModels}
                  selected={props.selectedOpencodeModels}
                  onToggle={props.toggleOpencodeModel}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ManualPath({
  cliId,
  value,
  onChange,
  error,
  busy,
  onSubmit,
}: {
  cliId: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
  busy: boolean;
  onSubmit: () => void;
}) {
  const bin = manualBinaryName(cliId);
  return (
    <div className="ml-8 mt-1 space-y-2 rounded-md border border-border bg-card/50 p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Paste the full path to the{" "}
        <code className="rounded bg-muted px-1">{bin}</code> binary. On
        macOS/Linux, run{" "}
        <code className="rounded bg-muted px-1">which {bin}</code> in your
        terminal to find it. On Windows, use{" "}
        <code className="rounded bg-muted px-1">where</code> instead.
      </p>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/usr/local/bin/claude or C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd"
          className="flex-1 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onSubmit}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
        </Button>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">
          Not installed yet? How to add it to PATH
        </summary>
        <div className="mt-2 space-y-1 leading-relaxed">
          <p>
            <strong>macOS / Linux:</strong> add{" "}
            <code className="rounded bg-muted px-1">
              export PATH="$HOME/.local/bin:$PATH"
            </code>{" "}
            to <code>~/.zshrc</code> or <code>~/.bashrc</code>, then{" "}
            <code className="rounded bg-muted px-1">source ~/.zshrc</code>.
          </p>
          <p>
            <strong>Windows:</strong> Settings → System → About → Advanced
            system settings → Environment Variables → edit <code>Path</code>{" "}
            for your user.
          </p>
          <p>After updating PATH, restart Chorus and re-run onboarding.</p>
        </div>
      </details>
    </div>
  );
}
