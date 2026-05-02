"use client";

import { useEffect, useState } from "react";
import { listVoices } from "@/lib/api/voices";
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
import {
  UI_LINEAGE_BRAND,
  UI_LINEAGE_DEFAULT_MODEL,
  UI_LINEAGE_LABEL,
} from "@/lib/lineage-maps";

// ─── Types & constants ───────────────────────────────────────────────

const KIND_ICON: Record<PhaseKind, React.ComponentType<{ className?: string }>> = {
  review: Eye,
  review_only: Eye,
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
  { id: "review_only", label: "Review only (artifact)" },
  { id: "divergence", label: "Divergence" },
  { id: "recon", label: "Recon" },
];

const LINEAGES: { id: ReviewerLineage; label: string; dot: string }[] = (
  ["claude", "codex", "gemini", "opencode", "kimi"] as const
).map((id) => ({ id, label: UI_LINEAGE_LABEL[id], dot: UI_LINEAGE_BRAND[id].dot }));

const DEFAULT_MODELS: Record<ReviewerLineage, string> = UI_LINEAGE_DEFAULT_MODEL;

// ─── Public API ──────────────────────────────────────────────────────

interface PhaseEditorProps {
  phases: TemplatePhase[];
  onChange: (next: TemplatePhase[]) => void;
}

/**
 * Reactive copy of enabled OpenCode voices — used to narrow the model
 * picker when lineage is opencode so users can't pick a model they
 * didn't authorise. One fetch per PhaseEditor mount is enough; voices
 * updates are rare and a manual page refresh covers them.
 *
 * Explicit `enabled: true` filter — this is the template-dropdown
 * context, where only enabled voices should appear.
 *
 * Filter is by `provider='opencode-cli'`, NOT `lineage='opencode'`.
 * This intentionally mirrors the v0.7 substrate which only knew about
 * the OpenCode CLI subscription path. When OpenRouter ships in PR 2/3,
 * api-routed opencode-lineage voices may exist (e.g. via the openrouter
 * provider routing through a deepseek model that we tag as
 * lineage='opencode'). Widening this dropdown to include those is
 * intentionally deferred to PR 2/3 — by then we'll have a better idea
 * of how api voices interact with the existing template runner. Round
 * 1 gem-2 BLOCKER 4 flagged this; deferred-with-comment per the PR
 * scope discussion.
 */
function useEnabledOpencodeModels(): string[] {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    listVoices({ provider: "opencode-cli", enabled: true })
      .then((voices) => {
        setModels(voices.map((v) => v.model_id));
      })
      .catch(() => {
        /* voices load is best-effort; freeform input still works */
      });
  }, []);
  return models;
}

// Daemon-lineage → cockpit-lineage mapping for the voices grouping. Kept
// inline so phase-editor stays decoupled from the dialog file.
const DAEMON_TO_COCKPIT_LINEAGE: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
  // Legacy alias from older templates.
  xai: "opencode",
};

interface ConnectedVoiceMap {
  /** Per-cockpit-lineage list of enabled model_ids. */
  byLineage: Partial<Record<ReviewerLineage, string[]>>;
  /** Set of cockpit-lineages that have at least one enabled voice. */
  connectedLineages: Set<ReviewerLineage>;
  /** True once the initial fetch settled (success or error). */
  loaded: boolean;
}

/**
 * Loads every enabled voice once and groups by cockpit-lineage so the
 * doer + reviewer dropdowns can show real options. Tolerates fetch
 * failure — falls back to empty maps; freeform fallback still lets the
 * user type a model id by hand.
 */
function useConnectedVoices(): ConnectedVoiceMap {
  const [state, setState] = useState<ConnectedVoiceMap>({
    byLineage: {},
    connectedLineages: new Set(),
    loaded: false,
  });
  useEffect(() => {
    listVoices({ enabled: true })
      .then((voices) => {
        const byLineage: Partial<Record<ReviewerLineage, string[]>> = {};
        const connectedLineages = new Set<ReviewerLineage>();
        for (const v of voices) {
          // 1. Bucket by daemon lineage (model family). e.g. opencode-go's
          //    kimi-k2.6 has lineage='moonshot' -> shows under cockpit "Kimi".
          const cockpitLineage = DAEMON_TO_COCKPIT_LINEAGE[v.lineage];
          if (cockpitLineage) {
            connectedLineages.add(cockpitLineage);
            (byLineage[cockpitLineage] ??= []).push(v.model_id);
          }
          // 2. ALSO bucket OpenCode-provider voices under cockpit "opencode"
          //    regardless of their model-family lineage. Why: OpenCode CLI
          //    exposes anything (DeepSeek, Kimi, GLM, …) and a user who
          //    picks "OpenCode" in the lineage dropdown wants every model
          //    their OpenCode CLI provides — not just the small subset
          //    where lineage=='opencode'. Without this, opencode-go/kimi
          //    only appeared under "Kimi" and never under "OpenCode".
          if (v.provider.startsWith("opencode") && cockpitLineage !== "opencode") {
            connectedLineages.add("opencode");
            (byLineage["opencode"] ??= []).push(v.model_id);
          }
        }
        // Dedupe within each lineage — same model could be exposed via
        // multiple providers (rare but possible with OpenCode + API).
        for (const k of Object.keys(byLineage) as ReviewerLineage[]) {
          byLineage[k] = Array.from(new Set(byLineage[k]!));
        }
        setState({ byLineage, connectedLineages, loaded: true });
      })
      .catch(() => setState({ byLineage: {}, connectedLineages: new Set(), loaded: true }));
  }, []);
  return state;
}

interface ModelSelectProps {
  lineage: ReviewerLineage;
  value: string;
  options: string[];
  onChange: (next: string) => void;
  /** Default model used as placeholder when value is empty. */
  defaultModel?: string;
}

/**
 * Dropdown of enabled models for a given lineage, with a final
 * "(custom — type your own)" option that swaps in a freeform input.
 * Preserves a value that isn't in the options list (template authored
 * elsewhere, or model since disabled) by including it as an extra option
 * marked "(not enabled)".
 */
function ModelSelect({ lineage, value, options, onChange, defaultModel }: ModelSelectProps) {
  const CUSTOM = "__custom__";
  const valueInOptions = !value || options.includes(value);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultModel ? `default: ${defaultModel}` : `${lineage} model id`}
          className="h-7 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none"
          autoFocus
        />
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="h-7 rounded-md border border-border bg-card/40 px-2 text-[10px] text-muted-foreground hover:text-foreground"
        >
          done
        </button>
      </div>
    );
  }

  if (options.length === 0) {
    // No enabled voices for this lineage — fall through to a freeform
    // input with a hint. Keeps the dialog usable on a fresh install.
    return (
      <div className="flex flex-col gap-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultModel ? `default: ${defaultModel}` : `${lineage} model id`}
          className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none"
        />
        <p className="text-[10px] text-amber-400/80">
          No {lineage} voices enabled. Configure in Connect to populate this dropdown.
        </p>
      </div>
    );
  }

  // Build the option list. If the current value isn't in `options`,
  // surface it as "(not enabled)" so we don't silently lose the
  // template's authored model on save.
  const allOptions = valueInOptions ? options : [value, ...options];

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setEditing(true);
          return;
        }
        onChange(e.target.value);
      }}
      className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground focus:border-primary/60 focus:outline-none"
    >
      {!value && (
        <option value="">
          {defaultModel ? `default: ${defaultModel}` : "— pick a model —"}
        </option>
      )}
      {allOptions.map((m) => (
        <option key={m} value={m}>
          {m}
          {!options.includes(m) && value === m ? " (not enabled)" : ""}
        </option>
      ))}
      <option value={CUSTOM}>+ custom (type a model id)…</option>
    </select>
  );
}

interface OpencodeModelInputProps {
  value: string;
  onChange: (next: string) => void;
  enabled: string[];
}

function OpencodeModelInput({ value, onChange, enabled }: OpencodeModelInputProps) {
  if (enabled.length === 0) {
    return (
      <div className="space-y-1">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="opencode-go/kimi-k2.6"
          className="h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
        />
        <p className="text-[10px] text-amber-400/80">
          No OpenCode models enabled — pick some in <span className="font-medium">Onboarding</span>.
        </p>
      </div>
    );
  }
  // Include the current value as an option even if it's not in the
  // enabled list, so editing an existing template doesn't silently
  // mutate the model on first save.
  const options = enabled.includes(value) || !value ? enabled : [value, ...enabled];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[11px] text-foreground focus:border-primary/60 focus:outline-none"
    >
      {!value && <option value="">— pick a model —</option>}
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

export function PhaseEditor({ phases, onChange }: PhaseEditorProps) {
  const enabledOpencodeModels = useEnabledOpencodeModels();
  const connectedVoices = useConnectedVoices();
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
            enabledOpencodeModels={enabledOpencodeModels}
            connectedVoices={connectedVoices}
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
  enabledOpencodeModels: string[];
  connectedVoices: ConnectedVoiceMap;
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
  enabledOpencodeModels,
  connectedVoices,
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
            {/* review_only phases have no doer — skip the doer chip and
                lead with the reviewers (and artifact label as a hint). */}
            {phase.kind !== "review_only" && (
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    LINEAGES.find((l) => l.id === phase.doer.lineage)?.dot,
                  )}
                />
                doer: {phase.doer.lineage}
              </span>
            )}
            {phase.reviewer.candidates.length > 0 && (
              <>
                {phase.kind !== "review_only" && (
                  <span className="text-muted-foreground/40">·</span>
                )}
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

          {/* Doer — review_only phases have no doer; runtime artifact stands
              in for the doer's output. The artifact section below replaces
              this whole block for review_only. */}
          {phase.kind !== "review_only" && (
          <SubField label="Doer · the agent that writes this phase's output">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {/* Show every lineage that has at least one enabled voice.
                  Until voices are loaded (or on first-run with zero
                  voices), fall through to the full lineage list so the
                  dialog stays usable. */}
              {LINEAGES.filter((l) =>
                connectedVoices.connectedLineages.size === 0
                  ? true
                  : connectedVoices.connectedLineages.has(l.id),
              ).map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => {
                    // Prefer an actually-enabled model so the template
                    // doesn't reference one the user can't reach. Fall
                    // back to the lineage's curated default when none
                    // are enabled.
                    const enabledForLineage =
                      connectedVoices.byLineage[l.id] ?? [];
                    const fallback =
                      enabledForLineage[0] ?? DEFAULT_MODELS[l.id];
                    onUpdate({
                      doer: {
                        lineage: l.id,
                        models: fallback ? [fallback] : [],
                      },
                    });
                  }}
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
            <div className="mt-2">
              <ModelSelect
                lineage={phase.doer.lineage}
                value={phase.doer.models[0] ?? ""}
                options={connectedVoices.byLineage[phase.doer.lineage] ?? []}
                defaultModel={DEFAULT_MODELS[phase.doer.lineage]}
                onChange={(next) =>
                  onUpdate({
                    doer: { ...phase.doer, models: next ? [next] : [] },
                  })
                }
              />
            </div>
          </SubField>
          )}

          {/* Artifact — review_only only. Runtime user pastes this into the
              cockpit when starting a chat; label/hint drive the textarea
              UX, maxBytes is enforced server-side. */}
          {phase.kind === "review_only" && (
            <SubField label="Artifact · what the user pastes when starting a chat">
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-muted-foreground">Label</label>
                  <input
                    type="text"
                    value={phase.artifact?.label ?? "Artifact to review"}
                    onChange={(e) =>
                      onUpdate({
                        artifact: {
                          label: e.target.value,
                          hint:
                            phase.artifact?.hint ??
                            "Paste a unified diff, a markdown draft, code, or any text blob.",
                          maxBytes: phase.artifact?.maxBytes ?? 1024 * 1024,
                        },
                      })
                    }
                    placeholder="Artifact to review"
                    className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2.5 text-[11px] placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">
                    Placeholder hint
                  </label>
                  <textarea
                    value={phase.artifact?.hint ?? ""}
                    onChange={(e) =>
                      onUpdate({
                        artifact: {
                          label: phase.artifact?.label ?? "Artifact to review",
                          hint: e.target.value,
                          maxBytes: phase.artifact?.maxBytes ?? 1024 * 1024,
                        },
                      })
                    }
                    placeholder="Paste a unified diff, a markdown draft, code, or any text blob."
                    rows={2}
                    className="mt-1 w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">
                    Max bytes (server-side cap)
                  </label>
                  <input
                    type="number"
                    min={1024}
                    step={1024}
                    value={phase.artifact?.maxBytes ?? 1024 * 1024}
                    onChange={(e) =>
                      onUpdate({
                        artifact: {
                          label: phase.artifact?.label ?? "Artifact to review",
                          hint:
                            phase.artifact?.hint ??
                            "Paste a unified diff, a markdown draft, code, or any text blob.",
                          maxBytes: Math.max(1024, parseInt(e.target.value, 10) || 1024 * 1024),
                        },
                      })
                    }
                    className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[11px] focus:border-primary/60 focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground/80">
                    1 MiB = 1048576. Default if unset.
                  </p>
                </div>
              </div>
            </SubField>
          )}

          {/* Reviewers — flat list of (lineage, model) rows. Each row =
              one reviewer slot. Same lineage with different models is
              fine (Codex gpt-5.5 + Codex gpt-5.5-pro as two reviewers).
              Lineage dropdown only shows the user's connected lineages
              (filtered by their enabled voices). Model dropdown shows
              all enabled models for the chosen lineage. */}
          <SubField label="Reviewers · who gates this phase">
            <ReviewerSlotsEditor
              phase={phase}
              connectedVoices={connectedVoices}
              onUpdate={onUpdate}
            />
          </SubField>

          <SubField label="Quorum">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                Require:
                <input
                  type="number"
                  min={0}
                  // Cap at the actual expanded reviewer-slot count rather
                  // than a hardcoded 4 — multi-model rows + 5 lineages can
                  // legitimately produce >4 slots, and a stale 4 made the
                  // input refuse a quorum that targets all of them.
                  max={Math.max(1, reviewerToRows(phase.reviewer).length)}
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
              {phase.kind !== "review_only" && (
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
              )}
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

          {/* Iterate / Gate — review_only is single-pass per the schema
              (no doer to revise; the runner doesn't loop). Hide these
              sections to avoid implying the runner does something it
              can't. */}
          {phase.kind !== "review_only" && (
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
          )}

          {/* Gate */}
          {phase.kind !== "review_only" && (
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
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reviewer slots editor ───────────────────────────────────────────
//
// One row per reviewer = (lineage, model). Same lineage can repeat with
// different models; each row emits its own entry in YAML candidates[].
// Internally we keep the existing candidates+candidateModels shape so
// nothing else has to change; the editor just flattens for display and
// re-derives both fields on each edit.

interface ReviewerSlotsEditorProps {
  phase: TemplatePhase;
  connectedVoices: ConnectedVoiceMap;
  onUpdate: (patch: Partial<TemplatePhase>) => void;
}

interface ReviewerRow {
  lineage: ReviewerLineage;
  model: string;
}

function reviewerToRows(reviewer: TemplatePhase["reviewer"]): ReviewerRow[] {
  const rows: ReviewerRow[] = [];
  for (const lineage of reviewer.candidates) {
    const models = reviewer.candidateModels?.[lineage];
    if (!models || models.length === 0) {
      rows.push({ lineage, model: "" });
    } else {
      for (const m of models) rows.push({ lineage, model: m });
    }
  }
  return rows;
}

function rowsToReviewer(
  rows: ReviewerRow[],
  base: TemplatePhase["reviewer"],
): TemplatePhase["reviewer"] {
  const candidates: ReviewerLineage[] = [];
  const candidateModels: Partial<Record<ReviewerLineage, string[]>> = {};
  for (const r of rows) {
    if (!candidates.includes(r.lineage)) candidates.push(r.lineage);
    if (r.model) (candidateModels[r.lineage] ??= []).push(r.model);
  }
  return { ...base, candidates, candidateModels };
}

function ReviewerSlotsEditor({
  phase,
  connectedVoices,
  onUpdate,
}: ReviewerSlotsEditorProps) {
  const rows = reviewerToRows(phase.reviewer);
  // Lineages the user has at least one enabled voice for. Falls through
  // to all 5 lineages on a fresh install with zero voices so the dialog
  // stays usable.
  const availableLineages = LINEAGES.filter((l) =>
    connectedVoices.connectedLineages.size === 0
      ? true
      : connectedVoices.connectedLineages.has(l.id),
  );

  function commit(nextRows: ReviewerRow[]) {
    onUpdate({ reviewer: rowsToReviewer(nextRows, phase.reviewer) });
  }

  function setRow(i: number, patch: Partial<ReviewerRow>) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    // When the user changes the lineage, reset the model to the new
    // lineage's first enabled voice (or default) — the previous model
    // belonged to a different lineage and won't make sense.
    if (patch.lineage && patch.lineage !== rows[i].lineage) {
      const enabledForNew = connectedVoices.byLineage[patch.lineage] ?? [];
      next[i].model = enabledForNew[0] ?? DEFAULT_MODELS[patch.lineage] ?? "";
    }
    commit(next);
  }

  function removeRow(i: number) {
    commit(rows.filter((_, idx) => idx !== i));
  }

  function addRow() {
    // Pick the first connected lineage as the default for new rows.
    const firstLineage =
      availableLineages[0]?.id ?? ("claude" as ReviewerLineage);
    const enabledForLineage =
      connectedVoices.byLineage[firstLineage] ?? [];
    const usedModelsForLineage = new Set(
      rows.filter((r) => r.lineage === firstLineage).map((r) => r.model),
    );
    const fresh =
      enabledForLineage.find((m) => !usedModelsForLineage.has(m)) ??
      DEFAULT_MODELS[firstLineage] ??
      "";
    commit([...rows, { lineage: firstLineage, model: fresh }]);
  }

  return (
    <div className="space-y-1.5">
      {rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No reviewers yet. Click + add reviewer below.
        </p>
      )}
      {rows.map((row, i) => {
        const lineageMeta = LINEAGES.find((x) => x.id === row.lineage);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={row.lineage}
              onChange={(e) =>
                setRow(i, { lineage: e.target.value as ReviewerLineage })
              }
              className="h-7 w-32 shrink-0 rounded-md border border-border bg-background px-2 text-[11px] focus:border-primary/60 focus:outline-none"
              aria-label="Reviewer lineage"
            >
              {availableLineages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
              {/* If the current row references a lineage NOT in the
                  available list (template authored elsewhere), keep
                  showing it so editing doesn't silently swap it. */}
              {!availableLineages.find((l) => l.id === row.lineage) && (
                <option value={row.lineage}>
                  {lineageMeta?.label ?? row.lineage} (not connected)
                </option>
              )}
            </select>
            <div className="flex-1">
              <ModelSelect
                lineage={row.lineage}
                value={row.model}
                options={connectedVoices.byLineage[row.lineage] ?? []}
                defaultModel={DEFAULT_MODELS[row.lineage]}
                onChange={(next) => setRow(i, { model: next })}
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(i)}
              aria-label="Remove reviewer"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-card/40 text-muted-foreground hover:border-destructive/40 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-card/30 px-3 py-2 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:bg-card/50 hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        Add another reviewer
      </button>
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
