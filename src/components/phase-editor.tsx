"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  Eye,
  FileCode2,
  FlaskConical,
  GitPullRequest,
  Plus,
  Search,
  Shuffle,
  TestTube2,
  Trash2,
  X,
  Info,
} from "lucide-react";
import type {
  PhaseKind,
  ReviewerLineage,
  TemplatePhase,
} from "@/lib/mock-data";
import { cn } from "@/lib/utils";

// ─── Types & constants ───────────────────────────────────────────────

const KIND_ICON: Record<PhaseKind, React.ComponentType<{ className?: string }>> = {
  review: Eye,
  plan: ClipboardList,
  spec: FileCode2,
  tests: TestTube2,
  implement: Code2,
  verify: FlaskConical,
  pr: GitPullRequest,
  divergence: Shuffle,
  recon: Search,
};

const KINDS: { id: PhaseKind; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "spec", label: "Spec / API" },
  { id: "tests", label: "Tests" },
  { id: "implement", label: "Implement" },
  { id: "verify", label: "Verify" },
  { id: "pr", label: "Open PR" },
  { id: "review", label: "Review" },
  { id: "divergence", label: "Divergence" },
  { id: "recon", label: "Recon" },
];

const LINEAGES: { id: ReviewerLineage; label: string; dot: string }[] = [
  { id: "claude", label: "Claude", dot: "bg-violet-400" },
  { id: "codex", label: "Codex", dot: "bg-orange-400" },
  { id: "gemini", label: "Gemini", dot: "bg-blue-400" },
  { id: "opencode", label: "OpenCode", dot: "bg-emerald-400" },
];

const DEFAULT_MODELS: Record<ReviewerLineage, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview",
  opencode: "kimi-k2.6",
  kimi: "kimi-k2.6",
};

// ─── Public API ──────────────────────────────────────────────────────

interface PhaseEditorProps {
  phases: TemplatePhase[];
  onChange: (next: TemplatePhase[]) => void;
}

export function PhaseEditor({ phases, onChange }: PhaseEditorProps) {
  function update(idx: number, patch: Partial<TemplatePhase>) {
    onChange(phases.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  function move(idx: number, dir: -1 | 1) {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= phases.length) return;
    const next = [...phases];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    onChange(next);
  }

  function remove(idx: number) {
    onChange(phases.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...phases, makeDefaultPhase(phases.length)]);
  }

  const phaseIds = phases.map((p) => p.id);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Phases ({phases.length})
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          Each phase has a doer + reviewer. Adversarial by default.
        </span>
      </div>

      <div className="space-y-2">
        {phases.map((p, i) => (
          <PhaseCard
            key={p.id}
            phase={p}
            index={i}
            total={phases.length}
            allPhaseIds={phaseIds}
            onUpdate={(patch) => update(i, patch)}
            onMoveUp={() => move(i, -1)}
            onMoveDown={() => move(i, 1)}
            onDelete={() => remove(i)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-card/30 px-3 py-2.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:bg-card/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Add phase
      </button>
    </div>
  );
}

// ─── Phase card ──────────────────────────────────────────────────────

interface PhaseCardProps {
  phase: TemplatePhase;
  index: number;
  total: number;
  allPhaseIds: string[];
  onUpdate: (patch: Partial<TemplatePhase>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

function PhaseCard({
  phase,
  index,
  total,
  allPhaseIds,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onDelete,
}: PhaseCardProps) {
  const [expanded, setExpanded] = useState(index === 0);
  const KindIcon = KIND_ICON[phase.kind];
  const priorPhases = allPhaseIds.slice(0, index); // can't reference later phases

  return (
    <div className="rounded-lg border border-border bg-card/40">
      {/* Collapsed header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <KindIcon className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {phase.name || "Untitled phase"}
            </span>
            <span className="font-mono text-[10px] uppercase text-muted-foreground/70">
              {phase.kind}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  LINEAGES.find((l) => l.id === phase.doer.lineage)?.dot,
                )}
              />
              doer: {phase.doer.lineage}
            </span>
            {phase.reviewer.candidates.length > 0 && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="flex items-center gap-1">
                  reviewers:
                  {phase.reviewer.candidates.map((l) => (
                    <span
                      key={l}
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        LINEAGES.find((x) => x.id === l)?.dot,
                      )}
                      title={l}
                    />
                  ))}
                </span>
              </>
            )}
            {phase.reviewer.crossLineage && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-amber-300/90 font-mono text-[9px] uppercase">
                  cross-lineage
                </span>
              </>
            )}
            <span className="text-muted-foreground/40">·</span>
            <span
              className={cn(
                "font-mono text-[9px] uppercase",
                phase.execution === "sequential"
                  ? "text-amber-300/90"
                  : "text-emerald-300/80",
              )}
              title={
                phase.execution === "sequential"
                  ? "Sequential hostile — reviewers chain"
                  : "Parallel independent — reviewers vote"
              }
            >
              {phase.execution === "sequential" ? "sequential" : "parallel"}
            </span>
            {phase.inputs.exclude.length > 0 && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-rose-300/90 font-mono text-[9px]">
                  blind-to: {phase.inputs.exclude.join(",")}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn disabled={index === 0} onClick={onMoveUp} title="Move up">
            <ArrowUp className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            disabled={index === total - 1}
            onClick={onMoveDown}
            title="Move down"
          >
            <ArrowDown className="h-3 w-3" />
          </IconBtn>
          <IconBtn
            onClick={onDelete}
            title="Delete phase"
            className="hover:text-rose-400"
          >
            <Trash2 className="h-3 w-3" />
          </IconBtn>
          <span className="ml-1 text-muted-foreground/60">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        </div>
      </button>

      {/* Expanded editor */}
      {expanded && (
        <div className="space-y-4 border-t border-border bg-background/40 px-3 py-3">
          {/* Name + kind row */}
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <SubField label="Name">
              <input
                type="text"
                value={phase.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground focus:border-primary/60 focus:outline-none"
              />
            </SubField>
            <SubField label="Kind">
              <select
                value={phase.kind}
                onChange={(e) =>
                  onUpdate({ kind: e.target.value as PhaseKind })
                }
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground focus:border-primary/60 focus:outline-none"
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </SubField>
          </div>

          {/* Description */}
          <SubField label="Description">
            <input
              type="text"
              value={phase.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              placeholder="What this phase produces and why it exists."
              className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
            />
          </SubField>

          {/* Doer */}
          <SubField label="Doer · the agent that writes this phase's output">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {LINEAGES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() =>
                    onUpdate({
                      doer: {
                        lineage: l.id,
                        models: [DEFAULT_MODELS[l.id]],
                      },
                    })
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition",
                    phase.doer.lineage === l.id
                      ? "border-primary/40 bg-primary/10"
                      : "border-border bg-card/40 hover:border-foreground/30",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", l.dot)} />
                  <span className="text-xs">{l.label}</span>
                  {phase.doer.lineage === l.id && (
                    <Check className="ml-auto h-3 w-3 text-primary" />
                  )}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={phase.doer.models[0] ?? ""}
              onChange={(e) =>
                onUpdate({
                  doer: { ...phase.doer, models: [e.target.value] },
                })
              }
              placeholder="model id (e.g. claude-opus-4-7)"
              className="mt-2 h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
            />
          </SubField>

          {/* Reviewer rule */}
          <SubField label="Reviewer rule · who gates this phase">
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {LINEAGES.map((l) => {
                  const isDoer = l.id === phase.doer.lineage;
                  const selected = phase.reviewer.candidates.includes(l.id);
                  const blocked = phase.reviewer.crossLineage && isDoer;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      disabled={blocked}
                      onClick={() => {
                        const next = selected
                          ? phase.reviewer.candidates.filter((c) => c !== l.id)
                          : [...phase.reviewer.candidates, l.id];
                        onUpdate({
                          reviewer: { ...phase.reviewer, candidates: next },
                        });
                      }}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition",
                        blocked && "cursor-not-allowed opacity-40",
                        !blocked && selected
                          ? "border-blue-500/40 bg-blue-500/10"
                          : !blocked
                            ? "border-border bg-card/40 hover:border-foreground/30"
                            : "border-border bg-card/40",
                      )}
                      title={
                        blocked
                          ? "Same lineage as doer — blocked by cross-lineage rule"
                          : ""
                      }
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full", l.dot)} />
                      <span className="text-xs">{l.label}</span>
                      {selected && !blocked && (
                        <Check className="ml-auto h-3 w-3 text-blue-400" />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  Require:
                  <input
                    type="number"
                    min={0}
                    max={4}
                    value={phase.reviewer.require}
                    onChange={(e) =>
                      onUpdate({
                        reviewer: {
                          ...phase.reviewer,
                          require: Math.max(0, parseInt(e.target.value, 10) || 0),
                        },
                      })
                    }
                    className="h-6 w-12 rounded border border-border bg-background px-1.5 text-center font-mono text-[11px]"
                  />
                  approval{phase.reviewer.require === 1 ? "" : "s"}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={phase.reviewer.crossLineage}
                    onChange={(e) =>
                      onUpdate({
                        reviewer: {
                          ...phase.reviewer,
                          crossLineage: e.target.checked,
                        },
                      })
                    }
                    className="accent-primary"
                  />
                  Cross-lineage required
                </label>
              </div>
            </div>
          </SubField>

          {/* Execution mode — parallel vs sequential hostile */}
          <SubField label="Reviewer execution · how multiple reviewers interact">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => onUpdate({ execution: "parallel" })}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition",
                  phase.execution === "parallel"
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-border bg-card/40 hover:border-foreground/30",
                )}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  Parallel independent
                  <span className="font-mono text-[9px] uppercase text-emerald-300/80">
                    fast
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                  All reviewers see the same pack, work in isolation, vote.
                  Catches single-reviewer mistakes via consensus. Risk: shared
                  blind spots pass anyway.
                </p>
              </button>
              <button
                type="button"
                onClick={() => onUpdate({ execution: "sequential" })}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition",
                  phase.execution === "sequential"
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-border bg-card/40 hover:border-foreground/30",
                )}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  Sequential hostile
                  <span className="font-mono text-[9px] uppercase text-amber-300/80">
                    thorough
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                  Reviewers run in order. Each receives the already-hardened
                  output and hunts what the prior reviewer missed. Slower; only
                  works if the first reviewer's solution is sound.
                </p>
              </button>
            </div>
          </SubField>

          {/* Inputs */}
          {priorPhases.length > 0 && (
            <SubField label="Inputs · which prior phases this doer can read">
              <div className="space-y-1.5">
                {priorPhases.map((id) => {
                  const inc = phase.inputs.include.includes(id);
                  const exc = phase.inputs.exclude.includes(id);
                  const state: "none" | "include" | "exclude" = exc
                    ? "exclude"
                    : inc
                      ? "include"
                      : "none";
                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between rounded-md border border-border bg-card/30 px-2.5 py-1.5"
                    >
                      <code className="font-mono text-[11px] text-foreground">
                        {id}
                      </code>
                      <div className="flex items-center gap-1">
                        <ToggleChip
                          on={state === "include"}
                          tone="emerald"
                          onClick={() =>
                            onUpdate({
                              inputs: {
                                include: inc
                                  ? phase.inputs.include.filter((x) => x !== id)
                                  : [...phase.inputs.include, id],
                                exclude: phase.inputs.exclude.filter((x) => x !== id),
                              },
                            })
                          }
                        >
                          include
                        </ToggleChip>
                        <ToggleChip
                          on={state === "exclude"}
                          tone="rose"
                          onClick={() =>
                            onUpdate({
                              inputs: {
                                include: phase.inputs.include.filter((x) => x !== id),
                                exclude: exc
                                  ? phase.inputs.exclude.filter((x) => x !== id)
                                  : [...phase.inputs.exclude, id],
                              },
                            })
                          }
                        >
                          exclude (blind)
                        </ToggleChip>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
                <Info className="mt-0.5 h-2.5 w-2.5 shrink-0 text-muted-foreground/60" />
                <span>
                  <span className="font-mono text-rose-300">exclude</span>{" "}
                  prevents this doer from seeing that phase&apos;s output. Used
                  for info asymmetry — e.g. the implementer shouldn&apos;t see
                  the tests.
                </span>
              </p>
            </SubField>
          )}

          {/* Iterate */}
          <SubField label="Iterate · what happens when reviewer rejects">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground">
                  Max revise
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={phase.iterate.max}
                  onChange={(e) =>
                    onUpdate({
                      iterate: {
                        ...phase.iterate,
                        max: Math.max(1, parseInt(e.target.value, 10) || 1),
                      },
                    })
                  }
                  className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[11px]"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">
                  On max
                </label>
                <select
                  value={phase.iterate.onMax}
                  onChange={(e) =>
                    onUpdate({
                      iterate: {
                        ...phase.iterate,
                        onMax: e.target.value as "ask-user" | "loopback" | "fail",
                      },
                    })
                  }
                  className="mt-1 h-7 w-full rounded-md border border-border bg-background px-1.5 text-[11px]"
                >
                  <option value="ask-user">ask me</option>
                  <option value="loopback">loop back</option>
                  <option value="fail">fail</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">
                  Loop back to
                </label>
                <select
                  disabled={phase.iterate.onMax !== "loopback"}
                  value={phase.iterate.loopbackTo ?? ""}
                  onChange={(e) =>
                    onUpdate({
                      iterate: {
                        ...phase.iterate,
                        loopbackTo: e.target.value || undefined,
                      },
                    })
                  }
                  className="mt-1 h-7 w-full rounded-md border border-border bg-background px-1.5 text-[11px] disabled:opacity-40"
                >
                  <option value="">—</option>
                  {priorPhases.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </SubField>

          {/* Gate */}
          <SubField label="Gate · what happens when this phase finishes">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onUpdate({ gate: "auto" })}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-left transition",
                  phase.gate === "auto"
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-border bg-card/40 hover:border-foreground/30",
                )}
              >
                <div className="text-xs font-medium">Auto-proceed</div>
                <div className="text-[10px] text-muted-foreground">
                  Continue to next phase without asking.
                </div>
              </button>
              <button
                type="button"
                onClick={() => onUpdate({ gate: "ask-user" })}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-left transition",
                  phase.gate === "ask-user"
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-border bg-card/40 hover:border-foreground/30",
                )}
              >
                <div className="text-xs font-medium">Checkpoint (ask me)</div>
                <div className="text-[10px] text-muted-foreground">
                  Stop here, surface verdict, wait for click.
                </div>
              </button>
            </div>
          </SubField>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function makeDefaultPhase(idx: number): TemplatePhase {
  return {
    id: `phase-${idx + 1}`,
    name: `Phase ${idx + 1}`,
    description: "",
    kind: "review",
    gate: "auto",
    doer: { lineage: "claude", models: ["claude-opus-4-7"] },
    reviewer: {
      require: 1,
      crossLineage: true,
      candidates: ["codex"],
    },
    inputs: { include: [], exclude: [] },
    iterate: { max: 3, onMax: "ask-user" },
    blindSpots: [],
    execution: "sequential",
    builtin: false,
  };
}

function IconBtn({
  children,
  onClick,
  disabled,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={cn(
        "grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30",
        className,
      )}
    >
      {children}
    </button>
  );
}

function SubField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function ToggleChip({
  on,
  tone,
  onClick,
  children,
}: {
  on: boolean;
  tone: "emerald" | "rose";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tones = {
    emerald: on
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
      : "border-border bg-card/40 text-muted-foreground hover:border-emerald-500/30",
    rose: on
      ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
      : "border-border bg-card/40 text-muted-foreground hover:border-rose-500/30",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition",
        tones[tone],
      )}
    >
      {children}
    </button>
  );
}
