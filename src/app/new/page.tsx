"use client";

import { Suspense, useMemo, useState, useTransition, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Layers,
  Paperclip,
  X,
  DollarSign,
  Info,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listTemplates, createChat, DaemonError } from "@/lib/api";
import { Template } from "@/lib/types";

export default function NewChatPage() {
  return (
    <Suspense fallback={<AppShell><div className="p-8 text-sm text-muted-foreground">Loading…</div></AppShell>}>
      <NewChatPageInner />
    </Suspense>
  );
}

interface Attachment {
  id: string;
  name: string;
  kind: "file" | "diff" | "url";
  size?: string;
}

function NewChatPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((err) =>
        setLoadError(
          err instanceof DaemonError ? err.message : "Failed to load templates",
        ),
      );
  }, []);

  const templateId =
    params.get("template") ?? templates[0]?.id ?? "";
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const template = templates.find((t) => t.id === templateId) ?? templates[0];

  // Cost estimate: rough heuristic based on prompt length + attachments + reviewer count.
  const costEstimate = useMemo(() => {
    const reviewerCount =
      template.phases[0]?.reviewer.candidates.length ?? 3;
    const promptTokens = Math.ceil(prompt.length / 4);
    const attachTokens = attachments.length * 1500;
    const baseTokens = 800; // template prompt boilerplate
    const inputTokens = promptTokens + attachTokens + baseTokens;
    const outputTokens = 1200; // estimate per reviewer
    const perReviewerUsd = (inputTokens * 0.000003 + outputTokens * 0.000015);
    const total = perReviewerUsd * reviewerCount;
    return {
      usd: total,
      inputTokens,
      reviewerCount,
    };
  }, [prompt, attachments, template]);

  function addMockAttachment(kind: Attachment["kind"]) {
    const sample: Record<Attachment["kind"], Attachment> = {
      file: {
        id: `a-${Date.now()}`,
        name: "src/jobs/process_batch.ts",
        kind: "file",
        size: "4.2 KB",
      },
      diff: {
        id: `a-${Date.now()}`,
        name: "PR #1421 diff",
        kind: "diff",
        size: "+165 −6",
      },
      url: {
        id: `a-${Date.now()}`,
        name: "github.com/99xAgency/aurora/issues/89",
        kind: "url",
      },
    };
    setAttachments((prev) => [...prev, sample[kind]]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const overCap =
    template?.costCapUsd && template.costCapUsd > 0 && costEstimate.usd > template.costCapUsd;

  const [yoloMode, setYoloMode] = useState(false);

  async function handleStartRun() {
    if (!template || !prompt) return;

    setCreateError(null);
    startTransition(async () => {
      try {
        const chat = await createChat({
          work: prompt,
          templateId: template.id,
          files: attachments.length > 0 ? attachments.map((a) => a.name) : undefined,
        });
        router.push(`/runs/${chat.id}`);
      } catch (err) {
        setCreateError(
          err instanceof DaemonError ? err.message : "Failed to create chat",
        );
      }
    });
  }

  if (loadError) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
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
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            New chat
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Paste a task. Pick a template. Watch the council think.
          </h1>
        </div>

        {createError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{createError}</p>
          </div>
        )}

        {/* Template picker */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Picker
            icon={<Layers className="h-3.5 w-3.5" />}
            label="Template"
            value={template?.name || "Select a template"}
            wide
          >
            <ul className="space-y-1">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const newParams = new URLSearchParams(params);
                      newParams.set("template", t.id);
                      router.push(`/new?${newParams.toString()}`);
                    }}
                    className={`block w-full rounded-md p-2 text-left transition ${
                      t.id === templateId ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <div className="text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {t.description}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Picker>
        </div>

        {/* Prompt textarea */}
        <Card className="overflow-hidden p-0 mb-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want a council of LLMs to consider. Paste code, errors, design docs — whatever the panel needs to weigh in on."
            className="block w-full resize-none border-0 bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            rows={10}
          />

          {/* Attachments row */}
          {(attachments.length > 0 || true) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card/30 px-5 py-2.5">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="group inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-[10px] text-foreground"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                  {a.name}
                  {a.size && (
                    <span className="text-muted-foreground/60">· {a.size}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="text-muted-foreground/50 transition hover:text-rose-400"
                    aria-label="Remove attachment"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <div className="flex items-center gap-1 ml-auto">
                <button
                  type="button"
                  onClick={() => addMockAttachment("file")}
                  className="rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
                  title="Attach files from project"
                >
                  <Paperclip className="mr-1 inline-block h-3 w-3" />
                  File
                </button>
                <button
                  type="button"
                  onClick={() => addMockAttachment("diff")}
                  className="rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
                  title="Attach a PR diff"
                >
                  Diff
                </button>
                <button
                  type="button"
                  onClick={() => addMockAttachment("url")}
                  className="rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
                  title="Attach a URL"
                >
                  URL
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border bg-card/40 px-5 py-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Doer: {template.phases[0]?.doer.lineage}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                Reviewers:
                {template.phases[0]?.reviewer.candidates.map((l) => (
                  <span
                    key={l}
                    className="flex items-center gap-1"
                    title={l}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                    {l}
                  </span>
                ))}
                {template.phases[0]?.reviewer.crossLineage && (
                  <Badge
                    variant="outline"
                    className="ml-1 border-border font-mono text-[9px] uppercase"
                    title="Reviewer must be a different lineage than the doer"
                  >
                    cross-lineage
                  </Badge>
                )}
              </span>
              {template.phases.length > 1 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="font-mono text-[10px]">
                    {template.phases.length} phases
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              {/* Cost preview */}
              <div
                className={`flex items-center gap-1.5 font-mono text-[10px] ${
                  overCap ? "text-rose-300" : "text-muted-foreground"
                }`}
                title={`~${costEstimate.inputTokens.toLocaleString()} input tokens × ${costEstimate.reviewerCount} reviewers`}
              >
                <DollarSign className="h-3 w-3" />~${costEstimate.usd.toFixed(3)} est
                {template.costCapUsd > 0 && (
                  <span className="text-muted-foreground/60">
                    / cap ${template.costCapUsd.toFixed(2)}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={handleStartRun}
                disabled={!prompt || overCap || isPending}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${
                  !prompt || overCap || isPending
                    ? "cursor-not-allowed bg-muted text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {isPending ? "Starting..." : "Start the run"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Card>

        {overCap && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
            <span>
              Estimated cost <span className="font-mono">${costEstimate.usd.toFixed(3)}</span>{" "}
              exceeds template cap{" "}
              <span className="font-mono">${template.costCapUsd.toFixed(2)}</span>. Trim
              attachments, shorten the prompt, or raise the cap in template settings.
            </span>
          </div>
        )}

        {/* Yolo mode toggle */}
        <button
          type="button"
          onClick={() => setYoloMode((v) => !v)}
          className={`mb-4 flex w-full items-start justify-between gap-3 rounded-lg border px-4 py-3 text-left transition ${
            yoloMode
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-dashed border-border bg-card/30 hover:border-foreground/30"
          }`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-7 w-7 place-items-center rounded-md text-sm ${
                yoloMode
                  ? "bg-rose-500/20 text-rose-300"
                  : "bg-card text-muted-foreground"
              }`}
            >
              🚀
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  Yolo mode
                </span>
                <Badge
                  variant="outline"
                  className="border-rose-500/30 bg-rose-500/10 font-mono text-[10px] uppercase text-rose-300"
                >
                  unsafe
                </Badge>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {yoloMode
                  ? "Reviewer gates auto-approve. Permission prompts auto-allow. The driver merges without asking. Cost cap still enforced."
                  : "Skip every ask-user gate for this single run. Useful for trusted templates or trivial fixes."}
              </p>
            </div>
          </div>
          <span
            className={`flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition ${
              yoloMode
                ? "border-rose-500/40 bg-rose-500/20"
                : "border-border bg-card"
            }`}
          >
            <span
              className={`h-3.5 w-3.5 rounded-full transition-transform ${
                yoloMode ? "translate-x-4 bg-rose-400" : "bg-muted-foreground/50"
              }`}
            />
          </span>
        </button>

        {/* A/B test option */}
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">A/B test mode</span>
                <Badge variant="outline" className="text-[10px]">
                  beta
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Run this prompt against two templates in parallel — compare
                findings side-by-side.
              </p>
            </div>
            <button
              type="button"
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              Add second template
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

interface PickerProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  wide?: boolean;
  children: React.ReactNode;
}

function Picker({ icon, label, value, wide, children }: PickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm transition hover:border-muted-foreground/40"
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="font-medium">{value}</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div
            className={`absolute left-0 top-full z-20 mt-1 rounded-md border border-border bg-popover p-1.5 shadow-xl ${wide ? "w-80" : "w-56"}`}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
