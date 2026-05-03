"use client";

import { Suspense, useMemo, useState, useTransition, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Layers,
  DollarSign,
  Info,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listTemplates, createChat, DaemonError } from "@/lib/api";
import { getBillingMode, type BillingMode } from "@/lib/api/settings";
import { Template, isReviewOnlyTemplate } from "@/lib/types";
import { PageHeader } from "@/components/page-header";

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

// Pick the first meaningful line from a review-only artifact so the chat
// title reflects what the user pasted instead of a static framing prompt.
// Skips fence markers (``` / ~~~) and pure-whitespace lines, then truncates
// to ~80 chars on a word boundary so it slugs cleanly. Falls back to the
// previous static brief when nothing usable is found (empty input, all
// fences, etc).
function deriveReviewOnlyTitle(artifact: string): string {
  const fallback = "Review the supplied artifact independently.";
  if (!artifact) return fallback;
  const lines = artifact.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("```") || line.startsWith("~~~")) continue;
    const max = 80;
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return fallback;
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

  // Billing mode controls how the cost preview is rendered. Defaults to 'api'
  // until the daemon answers, so users on subscriptions see the conservative
  // dollar estimate briefly on first paint, then the truthful "subscription
  // quota" badge once the request resolves.
  const [billingMode, setBillingMode] = useState<BillingMode>("api");
  useEffect(() => {
    getBillingMode()
      .then((b) => setBillingMode(b.mode))
      .catch(() => {
        /* leave default 'api' */
      });
  }, []);

  const templateId =
    params.get("template") ?? templates[0]?.id ?? "";
  const [prompt, setPrompt] = useState("");
  // Attachments are deferred to v0.8 — see the removed File/Diff/URL row
  // below. Kept the empty array so cost-estimate math doesn't have to
  // branch and the daemon-call shape stays the same.
  const attachments: Attachment[] = [];

  const template = templates.find((t) => t.id === templateId) ?? templates[0];

  // Cost estimate: rough heuristic based on prompt length + attachments + reviewer count.
  // Two refinements over the v0.6 version:
  //   1. Multiplies by template.maxRounds so users see the worst-case cost
  //      when reviewers disagree and trigger retries (was ignoring this).
  //   2. Returns a `usdRangeMax` for the upper bound so the UI can render a
  //      range like "$0.30 – $0.90 (with retries)" instead of a misleading
  //      single number.
  // Subscription mode is applied at render time, not here — keep the dollar
  // math pure so it stays correct for users on API mode.
  const costEstimate = useMemo(() => {
    const reviewerCount =
      template?.phases?.[0]?.reviewer?.candidates?.length ?? 3;
    const maxRounds = Math.max(1, template?.maxRounds ?? 1);
    const promptTokens = Math.ceil(prompt.length / 4);
    const attachTokens = attachments.length * 1500;
    const baseTokens = 800; // template prompt boilerplate
    const inputTokens = promptTokens + attachTokens + baseTokens;
    const outputTokens = 1200; // estimate per reviewer
    const perReviewerUsd = (inputTokens * 0.000003 + outputTokens * 0.000015);
    const single = perReviewerUsd * reviewerCount;
    return {
      usd: single,
      usdRangeMax: single * maxRounds,
      inputTokens,
      reviewerCount,
      maxRounds,
    };
  }, [prompt, attachments, template]);

  // Cost-cap gate uses the worst-case (with retries) projection so a chat
  // doesn't sneak under the cap on the headline number then exceed it on the
  // first round of disagreement. Skipped entirely in subscription mode where
  // the user isn't paying per call.
  const overCap = Boolean(
    billingMode !== "subscription" &&
      template?.costCapUsd &&
      template.costCapUsd > 0 &&
      costEstimate.usdRangeMax > template.costCapUsd,
  );

  const [yoloMode, setYoloMode] = useState(false);
  const [repoPath, setRepoPath] = useState("");

  const reviewOnly = isReviewOnlyTemplate(template);
  const artifactSpec = reviewOnly ? template?.phases?.[0]?.artifact : undefined;

  async function handleStartRun() {
    if (!template || !prompt) return;

    // Pre-flight artifact size check so users hit a clear error before the
    // network round-trip. The daemon enforces this too — this is just a
    // nicer error path. Falls back to the schema default (1 MiB) when the
    // template doesn't declare its own cap.
    if (reviewOnly && artifactSpec) {
      const byteLen = new TextEncoder().encode(prompt).length;
      if (byteLen > artifactSpec.maxBytes) {
        setCreateError(
          `Artifact is ${byteLen.toLocaleString()} bytes; this template caps at ${artifactSpec.maxBytes.toLocaleString()}. Trim it down.`,
        );
        return;
      }
    }

    setCreateError(null);
    startTransition(async () => {
      try {
        const trimmedRepo = repoPath.trim();
        const chat = await createChat({
          // For review-only templates, `prompt` IS the artifact. work is a
          // static framing brief — reviewers see it but it doesn't drive
          // their critique. For standard templates, prompt becomes work as
          // before. For review-only we derive a recognisable title from the
          // first non-empty, non-fenced line of the artifact so the sidebar
          // and run header reflect what the user actually pasted, not the
          // template's framing prompt.
          work: reviewOnly ? deriveReviewOnlyTitle(prompt) : prompt,
          templateId: template.id,
          files: attachments.length > 0 ? attachments.map((a) => a.name) : undefined,
          ...(reviewOnly ? { artifact: prompt } : {}),
          // Ship phase is meaningless for review-only — runner enforces this
          // too, but skip wiring the repoPath so the cockpit doesn't pretend
          // it'll open a PR.
          ...(!reviewOnly && trimmedRepo.length > 0 ? { repoPath: trimmedRepo } : {}),
          // Yolo only matters for chats with a ship phase; the daemon
          // ignores it on review-only runs. Sending it unconditionally
          // keeps the call signature simple.
          yolo: yoloMode,
        });
        router.push(`/runs/${chat.slug || chat.id}`);
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
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">Error loading templates</p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!template) {
    return (
      <AppShell>
        <div className="mx-auto w-full max-w-6xl px-4 py-12 text-sm text-muted-foreground sm:px-6 md:px-8">
          Loading templates…
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <PageHeader
          eyebrow="New chat"
          title={reviewOnly ? "Paste an artifact. Get reviews." : "Paste a task. Pick a template."}
          subtitle={
            reviewOnly
              ? "Chorus skips the doer and runs your text past three reviewers. Single pass — revise yourself and resubmit for another round."
              : "Chorus runs it past your reviewers and reports consensus."
          }
        />

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
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      {isReviewOnlyTemplate(t) && (
                        <Badge
                          variant="outline"
                          className="border-blue-500/30 bg-blue-500/10 font-mono text-[9px] uppercase text-blue-300"
                        >
                          review only
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {t.description}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Picker>
        </div>

        {/* Prompt textarea — for review-only templates, this becomes the
            artifact field directly: monospace, taller, explicit label. */}
        {reviewOnly && artifactSpec && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{artifactSpec.label}</span>
            <span className="text-muted-foreground/60">·</span>
            <span>cap {(artifactSpec.maxBytes / 1024).toLocaleString()} KB</span>
            <span className="text-muted-foreground/60">·</span>
            {/* Reviewers terminate their stream on a `## DONE` marker.
                Surfaced in the label row so users know the convention
                without having to read a template's `askContent`. */}
            <span className="text-muted-foreground/80">
              end your prompt with <code className="rounded bg-muted/40 px-1 font-mono text-[10px] text-foreground/80">## DONE</code> so reviewers know when to stop
            </span>
          </div>
        )}
        <Card className="overflow-hidden p-0 mb-4">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              reviewOnly && artifactSpec
                ? artifactSpec.hint
                : "Describe what you want chorus to weigh in on. Paste code, errors, design docs — anything the reviewers should see."
            }
            className={`block w-full resize-none border-0 bg-transparent px-5 py-4 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none ${
              reviewOnly ? "font-mono text-[12px] leading-relaxed" : ""
            }`}
            rows={reviewOnly ? 16 : 10}
            spellCheck={!reviewOnly}
          />

          {/* Attachments row removed for v0.7 — File / Diff / URL buttons
              were calling `addMockAttachment` which only added decorative
              chips; nothing was actually fetched, parsed, or sent to the
              daemon. Re-add when the upload + URL-fetch + PR-diff parser
              paths are wired (planning/v0.8.md). */}

          <div className="flex flex-col gap-3 border-t border-border bg-card/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {/* No doer card for review-only — there's no spawned doer; the
                  artifact IS the input. The reviewers row carries all the
                  information the user needs about who'll critique it. */}
              {!reviewOnly && (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    Doer: {template.phases[0]?.doer.lineage}
                  </span>
                  <span className="text-muted-foreground/50">·</span>
                </>
              )}
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                Reviewers:
                {(() => {
                  // Two reviewer rows on the same lineage are indistinguishable
                  // at "codex · gemini · opencode · opencode" — caught in the
                  // 2026-05-03 UX walk. When ≥2 candidates share a lineage,
                  // append the model so a user can tell e.g. opencode-go/kimi
                  // apart from opencode-go/deepseek before submitting.
                  const slots = template.phases[0]?.reviewer.candidatesWithModels ?? [];
                  const lineageCounts = new Map<string, number>();
                  for (const slot of slots) {
                    lineageCounts.set(slot.lineage, (lineageCounts.get(slot.lineage) ?? 0) + 1);
                  }
                  return slots.map((slot, i) => {
                    const dup = (lineageCounts.get(slot.lineage) ?? 0) > 1;
                    const modelLabel = slot.models?.[0]?.split("/").pop() ?? slot.models?.[0];
                    const label = dup && modelLabel ? `${slot.lineage} · ${modelLabel}` : slot.lineage;
                    return (
                      <span
                        key={`${slot.lineage}-${slot.models?.[0] ?? "default"}-${i}`}
                        className="flex items-center gap-1"
                        title={slot.models?.[0] ? `${slot.lineage} · ${slot.models[0]}` : slot.lineage}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                        {label}
                      </span>
                    );
                  });
                })()}
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
            <div className="flex items-center justify-between gap-3 sm:justify-end">
              {/* Cost preview — subscription users see "Subscription quota"
                  with token count; API users see a low–high range that
                  reflects the maxRounds retry multiplier. */}
              {billingMode === "subscription" ? (
                <div
                  className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
                  title={`~${costEstimate.inputTokens.toLocaleString()} input tokens × ${costEstimate.reviewerCount} reviewers — counts against your CLI subscription quota, not billed per call`}
                >
                  Subscription quota · ~{costEstimate.inputTokens.toLocaleString()} tok
                </div>
              ) : (
                <div
                  className={`flex items-center gap-1.5 font-mono text-[10px] ${
                    overCap ? "text-rose-300" : "text-muted-foreground"
                  }`}
                  title={`~${costEstimate.inputTokens.toLocaleString()} input tokens × ${costEstimate.reviewerCount} reviewers; up to ${costEstimate.maxRounds} round${costEstimate.maxRounds > 1 ? "s" : ""} on disagreement`}
                >
                  <DollarSign className="h-3 w-3" />
                  {costEstimate.maxRounds > 1
                    ? `~$${costEstimate.usd.toFixed(3)} – $${costEstimate.usdRangeMax.toFixed(3)} est`
                    : `~$${costEstimate.usd.toFixed(3)} est`}
                  {template.costCapUsd > 0 && (
                    <span className="text-muted-foreground/60">
                      / cap ${template.costCapUsd.toFixed(2)}
                    </span>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleStartRun}
                disabled={!prompt || overCap || isPending}
                className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition ${
                  !prompt || overCap || isPending
                    ? "cursor-not-allowed bg-muted text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {isPending ? "Starting..." : reviewOnly ? "Send for review" : "Start the run"}
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

        {/* Optional Target repo for the Ship phase. When set, the doer's
            cwd is this path and on success chorus opens a PR. Skip to run
            chorus on the prompt alone (no PR, just a verdict).
            Hidden for review-only templates — no doer means no diff to
            commit and the runner force-skips ship anyway. */}
        {!reviewOnly && (
        <div className="mb-4 rounded-lg border border-dashed border-border bg-card/30 p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Target repo <span className="text-muted-foreground">(optional)</span>
            </span>
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] uppercase text-emerald-300"
            >
              opens PR
            </Badge>
          </div>
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/absolute/path/to/repo"
            className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
            spellCheck={false}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            When set: doer makes real edits in this repo. After reviewers agree,
            chorus opens a PR via <code className="rounded bg-muted px-1">gh pr create</code>{" "}
            (no auto-merge — you review + click Merge in GitHub).
            Leave blank to skip the Ship phase.
          </p>
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

        {/* A/B test option removed for v0.7 — "Add second template" had
            no onClick, no dual-chat spawn logic, and no side-by-side run
            view. Lands in v0.8 once those exist. */}
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
