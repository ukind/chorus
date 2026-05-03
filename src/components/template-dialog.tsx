"use client";

/**
 * TemplateDialog — single dialog handles both NEW and EDIT.
 *
 * Modes:
 *   - new: opens with a default skeleton, generates an id from the name on
 *     save. Form tab default.
 *   - edit: opens populated from an existing Template; preserves the id.
 *     YAML tab default for review_only / ship templates (form mode would
 *     drop fields the form doesn't model). Otherwise form tab default.
 *
 * Validation:
 *   Live as the user types via `validateTemplateYaml` (yaml syntax → zod).
 *   Save is gated on `valid: true`. Server re-validates and returns the
 *   same shape, so a successful client validate followed by a server
 *   reject is a real bug worth surfacing.
 *
 * Save:
 *   Calls `saveTemplate({id, yaml})`. Success → invokes `onSaved(template)`
 *   so the parent can refresh its list and keep the same selection. Failure
 *   → keeps the dialog open, shows the server error inline.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
  Sparkles,
  Loader2,
  Pencil,
  ChevronLeft,
  ChevronRight,
  Layers,
  Sliders,
  Shuffle,
  Tag,
} from "lucide-react";
import yaml from "yaml";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type {
  AgreementThreshold,
  ReviewerLineage,
  Template,
  TemplatePhase,
  ThresholdAction,
} from "@/lib/mock-data";
import { PhaseEditor, useConnectedVoices, type ConnectedVoiceMap } from "@/components/phase-editor";
import { cn } from "@/lib/utils";
import { saveTemplate, DaemonError } from "@/lib/api";
import {
  validateTemplateYaml,
  type TemplateValidationIssue,
} from "@/lib/template-validation";
import { selectLiveYaml } from "@/lib/template-live-yaml";

// ─── Lineage translation (cockpit ↔ daemon schema) ──────────────────────

const COCKPIT_TO_DAEMON: Record<ReviewerLineage, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  kimi: "moonshot",
  // openrouter voices carry an explicit `openrouter:<model>` id; the
  // template's lineage field still records the underlying lineage so
  // diversity scoring works. The "openrouter" UI lineage exists for
  // run-page rendering only — not a daemon-side template lineage.
  openrouter: "openrouter",
};

const DAEMON_TO_COCKPIT: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
  // Legacy alias from old templates.
  xai: "opencode",
};

const DAEMON_DEFAULT_MODEL: Record<ReviewerLineage, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview",
  opencode: "kimi-k2.6",
  kimi: "kimi-k2.6",
  openrouter: "",
};

// ─── Form ↔ daemon agreement-threshold ──────────────────────────────────

function thresholdToNumber(t: AgreementThreshold): number {
  switch (t) {
    case "unanimous":
      return 1;
    case "majority":
      return 0.66;
    case "any":
      return 0.34;
  }
}

function thresholdFromNumber(n: number): AgreementThreshold {
  if (n >= 0.99) return "unanimous";
  if (n >= 0.5) return "majority";
  return "any";
}

function actionToDaemon(a: ThresholdAction): "merge" | "ask" | "review" {
  return a === "auto-finalize" ? "merge" : "ask";
}

function actionFromDaemon(s: string | undefined): ThresholdAction {
  return s === "merge" ? "auto-finalize" : "ask-user";
}

// ─── Schema-correct YAML emission via yaml.stringify ────────────────────

interface FormState {
  /** Stable id once known — set on edit, derived on save for new templates. */
  id: string;
  name: string;
  description: string;
  /**
   * Original `author` from the YAML, preserved verbatim so editing a
   * community template doesn't silently rewrite ownership. Defaults to
   * "you" for brand-new templates.
   */
  author: string;
  category: Template["category"];
  phases: TemplatePhase[];
  threshold: AgreementThreshold;
  /**
   * Custom (non-preset) numeric threshold from the YAML. When set, the
   * `threshold` enum is the closest preset and the form tab is disabled
   * (lossy). Emitter prefers `customThreshold` when present so the YAML
   * round-trips unchanged.
   */
  customThreshold?: number;
  onThresholdMet: ThresholdAction;
  /**
   * Captures the literal "review" value from the daemon when present.
   * Form's 2-value enum can't represent `review` — for that case the
   * form is disabled (lossy) and the emitter restores the literal from
   * here. Merge/ask are derivable from `onThresholdMet` via
   * actionToDaemon, so we deliberately do NOT capture them here (a stale
   * raw value would shadow a user's form edit).
   */
  onThresholdMetRaw?: "review";
  maxRounds: number;
  yoloDefault: boolean;
  /**
   * Template-level fallback voices, split by role. Tried in order when a
   * slot's per-slot model chain exhausts. Strict (lineage, model) dedup
   * against active slots of the same role in the same phase. Each entry
   * is one voice; chain order = priority.
   */
  fallbackDoer: FallbackVoice[];
  fallbackReviewer: FallbackVoice[];
}

interface FallbackVoice {
  lineage: ReviewerLineage;
  model: string;
  persona?: string;
}

const DEFAULT_PHASE: TemplatePhase = {
  id: "review",
  name: "Review",
  description: "Three independent critiques.",
  kind: "review",
  gate: "ask-user",
  doer: { lineage: "claude", models: ["claude-opus-4-7"] },
  reviewer: {
    require: 3,
    crossLineage: true,
    candidates: ["codex", "gemini", "opencode"],
  },
  inputs: { include: [], exclude: [] },
  iterate: { max: 3, onMax: "ask-user" },
  blindSpots: [],
  execution: "parallel",
  builtin: false,
};

const DEFAULT_FORM: FormState = {
  id: "",
  name: "",
  description: "",
  author: "you",
  category: "review",
  phases: [DEFAULT_PHASE],
  threshold: "unanimous",
  onThresholdMet: "ask-user",
  maxRounds: 3,
  yoloDefault: false,
  fallbackDoer: [],
  fallbackReviewer: [],
};

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "untitled"
  );
}

interface DaemonPhaseYaml {
  id: string;
  kind: string;
  title: string;
  description?: string;
  doer?: { lineage: string; models?: string[]; persona?: string };
  reviewer?: {
    require: number;
    crossLineage: boolean;
    candidates: { lineage: string; models?: string[]; persona?: string }[];
  };
  inputs: { include: string[]; exclude: string[] };
  /** Standard phases only — review_only is single-pass and has no iterate. */
  iterate?: {
    maxRounds: number;
    onDisagreement: "continue" | "escalate" | "accept-doer";
    shareSessionAcrossRounds: boolean;
    shareSessionAcrossPhases: boolean;
  };
  /** review_only phases only — runtime artifact spec. */
  artifact?: {
    label: string;
    hint: string;
    maxBytes: number;
  };
}

interface DaemonTemplateYaml {
  id: string;
  name: string;
  description: string;
  author?: string;
  agreementThreshold: number;
  onThresholdMet: "merge" | "ask" | "review";
  maxRounds: number;
  yoloDefault: boolean;
  phases: DaemonPhaseYaml[];
  fallback?: {
    doer?: Array<{ lineage: string; models: string[]; persona?: string }>;
    reviewer?: Array<{ lineage: string; models: string[]; persona?: string }>;
  };
}

function formToDaemonShape(f: FormState): DaemonTemplateYaml {
  const id = f.id || slugify(f.name);
  return {
    id,
    name: f.name || "Untitled template",
    description: f.description || "Describe what this template is for.",
    author: f.author || "you",
    agreementThreshold:
      f.customThreshold !== undefined
        ? f.customThreshold
        : thresholdToNumber(f.threshold),
    onThresholdMet: f.onThresholdMetRaw ?? actionToDaemon(f.onThresholdMet),
    maxRounds: f.maxRounds,
    yoloDefault: f.yoloDefault,
    phases: f.phases.map((p): DaemonPhaseYaml => {
      const isReviewOnly = p.kind === "review_only";
      const reviewerBlock =
        p.reviewer.candidates.length > 0
          ? {
              require: p.reviewer.require,
              crossLineage: p.reviewer.crossLineage,
              // flatMap so each lineage with multiple models in
              // candidateModels emits one candidate-entry per model.
              // Lets the user pick e.g. codex gpt-5.5 + codex gpt-5.5-pro
              // as two reviewers. When candidateModels has nothing for
              // this lineage we emit a single entry with the curated
              // default so the runner has something to spawn.
              candidates: p.reviewer.candidates.flatMap((l) => {
                const userPicked = (
                  p.reviewer.candidateModels?.[l] ?? []
                )
                  .map((m) => m.trim())
                  .filter((m) => m.length > 0);
                const personasByModel = p.reviewer.candidatePersonas?.[l];
                const daemonLineage = COCKPIT_TO_DAEMON[l] ?? "anthropic";
                if (userPicked.length === 0) {
                  const fallback = DAEMON_DEFAULT_MODEL[l] ?? "claude-opus-4-7";
                  // Lineage-only slots store their persona under the "" key.
                  const persona = personasByModel?.[""];
                  return [{
                    lineage: daemonLineage,
                    models: [fallback],
                    ...(persona ? { persona } : {}),
                  }];
                }
                return userPicked.map((m) => {
                  const persona = personasByModel?.[m];
                  return {
                    lineage: daemonLineage,
                    models: [m],
                    ...(persona ? { persona } : {}),
                  };
                });
              }),
            }
          : undefined;

      // review_only: drop doer + iterate, add artifact block. Schema rejects
      // a doer field on review_only and also rejects iterate, so the keys
      // must literally not be present.
      if (isReviewOnly) {
        return {
          id: p.id,
          kind: p.kind,
          title: p.name,
          description: p.description,
          reviewer: reviewerBlock,
          inputs: { include: p.inputs.include, exclude: p.inputs.exclude },
          artifact: {
            label: p.artifact?.label ?? "Artifact to review",
            hint:
              p.artifact?.hint ??
              "Paste a unified diff, a markdown draft, code, or any text blob.",
            maxBytes: p.artifact?.maxBytes ?? 1024 * 1024,
          },
        };
      }

      // Standard phase: doer + reviewer + iterate.
      return {
        id: p.id,
        kind: p.kind,
        title: p.name,
        description: p.description,
        doer: {
          lineage: COCKPIT_TO_DAEMON[p.doer.lineage] ?? "anthropic",
          models:
            p.doer.models.length > 0
              ? p.doer.models
              : [DAEMON_DEFAULT_MODEL[p.doer.lineage] ?? "claude-opus-4-7"],
          ...(p.doer.persona ? { persona: p.doer.persona } : {}),
        },
        reviewer: reviewerBlock,
        inputs: { include: p.inputs.include, exclude: p.inputs.exclude },
        iterate: {
          maxRounds: p.iterate.max,
          // Form's onMax → daemon's onDisagreement enum mapping:
          //   loopback  → 'continue'    (keep iterating with revisions)
          //   ask-user  → 'escalate'    (surface to user, halt loop)
          //   fail      → 'accept-doer' (drop reviewer veto, accept doer)
          // Pre-fix this emitted 'ask-user' which the schema rejects with
          // "Expected 'continue' | 'escalate' | 'accept-doer'", causing
          // every template saved from the wizard to fail validation.
          onDisagreement:
            p.iterate.onMax === "loopback"
              ? "continue"
              : p.iterate.onMax === "fail"
                ? "accept-doer"
                : "escalate",
          shareSessionAcrossRounds: true,
          shareSessionAcrossPhases: false,
        },
      };
    }),
    // Template-level fallback chains, split by role. Emitted only when at
    // least one role has rows, so older templates round-trip unchanged.
    // Priority order matches form order.
    ...(f.fallbackDoer.length > 0 || f.fallbackReviewer.length > 0
      ? {
          fallback: {
            ...(f.fallbackDoer.length > 0
              ? {
                  doer: f.fallbackDoer.map((fb) => ({
                    lineage: COCKPIT_TO_DAEMON[fb.lineage] ?? "anthropic",
                    models: [fb.model],
                    ...(fb.persona ? { persona: fb.persona } : {}),
                  })),
                }
              : {}),
            ...(f.fallbackReviewer.length > 0
              ? {
                  reviewer: f.fallbackReviewer.map((fb) => ({
                    lineage: COCKPIT_TO_DAEMON[fb.lineage] ?? "anthropic",
                    models: [fb.model],
                    ...(fb.persona ? { persona: fb.persona } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

function buildYamlFromForm(f: FormState): string {
  return yaml.stringify(formToDaemonShape(f), { lineWidth: 0 });
}

// ─── YAML → FormState (best-effort parser for edit mode) ────────────────

interface ParsedDaemonTemplate {
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  agreementThreshold?: number | string;
  onThresholdMet?: string;
  maxRounds?: number;
  yoloDefault?: boolean;
  ship?: { enabled?: boolean };
  phases?: Array<{
    id?: string;
    kind?: string;
    title?: string;
    name?: string;
    description?: string;
    doer?: { lineage?: string; models?: string[]; persona?: string };
    reviewer?: {
      require?: number;
      crossLineage?: boolean;
      candidates?: Array<{ lineage?: string; models?: string[]; persona?: string }>;
    };
    inputs?: { include?: string[]; exclude?: string[] };
    iterate?: { maxRounds?: number; onDisagreement?: string };
    artifact?: { label?: string; hint?: string; maxBytes?: number };
    timeoutMs?: number;
  }>;
  fallback?: {
    doer?: Array<{ lineage?: string; models?: string[]; persona?: string }>;
    reviewer?: Array<{ lineage?: string; models?: string[]; persona?: string }>;
  };
}

interface ParseResult {
  form: FormState;
  /** True if the YAML contains fields the form can't represent (form tab → readonly). */
  formLossy: boolean;
  lossyReasons: string[];
}

function parseYamlToForm(yamlText: string, existingId: string): ParseResult {
  const reasons: string[] = [];
  let parsed: ParsedDaemonTemplate;
  try {
    parsed = (yaml.parse(yamlText) as ParsedDaemonTemplate) ?? {};
  } catch {
    return {
      form: { ...DEFAULT_FORM, id: existingId },
      formLossy: true,
      lossyReasons: ["YAML failed to parse — only YAML mode is available."],
    };
  }

  if (parsed.ship?.enabled) {
    reasons.push("Template has `ship.enabled: true` — form mode can't edit ship config.");
  }

  const phases: TemplatePhase[] = (parsed.phases ?? []).map((p) => {
    if (p.timeoutMs !== undefined) {
      reasons.push("Phase " + (p.id ?? "?") + " has `timeoutMs` — not exposed in form mode.");
    }
    const isReviewOnly = p.kind === "review_only";
    // review_only has no doer in YAML; pick a sensible placeholder so the
    // FormState shape stays uniform. The form hides the doer panel for
    // review_only and the YAML emitter drops it.
    const doerLineage = isReviewOnly
      ? "claude"
      : DAEMON_TO_COCKPIT[p.doer?.lineage ?? ""] ?? "claude";
    // Accumulate per-lineage models from YAML, then derive the unique
    // lineage list. The form's chip row needs ONE chip per lineage even
    // when YAML has duplicate-lineage entries (e.g. codex gpt-5.5 +
    // codex gpt-5.5-pro), and the model picker for that lineage shows
    // both as separate rows.
    const candidateModels: Partial<Record<ReviewerLineage, string[]>> = {};
    const candidatePersonas: Partial<
      Record<ReviewerLineage, Record<string, string | undefined>>
    > = {};
    const seenLineages = new Set<ReviewerLineage>();
    const candidates: ReviewerLineage[] = [];
    // Track when a (lineage, model) tuple appears in two different YAML
    // candidate blocks with conflicting personas. The form's
    // one-persona-per-tuple representation can't faithfully store both,
    // so we set a lossy reason and let the user fix it in YAML mode.
    // Flagged in retroactive PR #23 review by opencode-deepseek.
    const overlapConflicts: string[] = [];
    for (const c of p.reviewer?.candidates ?? []) {
      const cockpitLineage = DAEMON_TO_COCKPIT[c.lineage ?? ""];
      if (!cockpitLineage) continue;
      if (!seenLineages.has(cockpitLineage)) {
        seenLineages.add(cockpitLineage);
        candidates.push(cockpitLineage);
      }
      // YAML candidates may declare persona without an explicit model;
      // keying the persona map by model allows the form to round-trip
      // either case ("" for the lineage-only slot, model id for the rest).
      const trimmedModels = (c.models ?? [])
        .map((m) => (m ?? "").trim())
        .filter((m) => m.length > 0);
      const yamlPersona =
        c.persona && c.persona.trim().length > 0 ? c.persona : undefined;
      const writePersona = (modelKey: string): void => {
        if (!yamlPersona) return;
        const map = (candidatePersonas[cockpitLineage] ??= {});
        const existing = map[modelKey];
        if (existing !== undefined && existing !== yamlPersona) {
          overlapConflicts.push(
            `${cockpitLineage}/${modelKey || "(no model)"}: "${existing}" vs "${yamlPersona}"`,
          );
        }
        map[modelKey] = yamlPersona;
      };
      if (trimmedModels.length === 0) {
        writePersona("");
      } else {
        for (const m of trimmedModels) {
          (candidateModels[cockpitLineage] ??= []).push(m);
          writePersona(m);
        }
      }
    }
    if (overlapConflicts.length > 0) {
      reasons.push(
        `Phase ${p.id ?? "?"} has overlapping reviewer candidates with conflicting personas (${overlapConflicts.join("; ")}) — form mode would silently last-write-wins; edit in YAML to disambiguate.`,
      );
    }

    const KNOWN_KINDS = [
      "plan",
      "spec",
      "tests",
      "implement",
      "review",
      "verify",
      "divergence",
      "review_only",
    ] as const;
    const phaseKind = KNOWN_KINDS.includes(p.kind as never)
      ? (p.kind as TemplatePhase["kind"])
      : "review";
    if (p.kind && !KNOWN_KINDS.includes(p.kind as never)) {
      reasons.push(
        `Phase ${p.id ?? "?"} has unknown kind \`${p.kind}\` — form mode would coerce it to \`review\`.`,
      );
    }

    return {
      id: p.id ?? "phase",
      name: p.title ?? p.name ?? p.id ?? "Phase",
      description: p.description ?? "",
      kind: phaseKind,
      gate: "auto",
      doer: {
        lineage: doerLineage,
        models:
          p.doer?.models && p.doer.models.length > 0
            ? p.doer.models
            : [DAEMON_DEFAULT_MODEL[doerLineage] ?? "claude-opus-4-7"],
        ...(p.doer?.persona && p.doer.persona.trim().length > 0
          ? { persona: p.doer.persona.trim() }
          : {}),
      },
      reviewer: {
        require: p.reviewer?.require ?? 1,
        crossLineage: p.reviewer?.crossLineage ?? true,
        candidates,
        candidateModels,
        ...(Object.keys(candidatePersonas).length > 0
          ? { candidatePersonas }
          : {}),
      },
      inputs: {
        include: p.inputs?.include ?? [],
        exclude: p.inputs?.exclude ?? [],
      },
      iterate: {
        max: p.iterate?.maxRounds ?? 3,
        // Inverse of the formToDaemonShape mapping above. Keep the two in
        // sync — daemon enum 'continue'/'escalate'/'accept-doer' →
        // form 'loopback'/'ask-user'/'fail'.
        onMax:
          p.iterate?.onDisagreement === "continue"
            ? "loopback"
            : p.iterate?.onDisagreement === "accept-doer"
              ? "fail"
              : "ask-user",
      },
      blindSpots: [],
      execution: "parallel",
      builtin: false,
      // Preserve the artifact block on review_only so the form can edit
      // it and the emitter can re-emit it. Other phase kinds leave this
      // undefined.
      ...(isReviewOnly && p.artifact
        ? {
            artifact: {
              label: p.artifact.label ?? "Artifact to review",
              hint:
                p.artifact.hint ??
                "Paste a unified diff, a markdown draft, code, or any text blob.",
              maxBytes: p.artifact.maxBytes ?? 1024 * 1024,
            },
          }
        : isReviewOnly
          ? {
              artifact: {
                label: "Artifact to review",
                hint: "Paste a unified diff, a markdown draft, code, or any text blob.",
                maxBytes: 1024 * 1024,
              },
            }
          : {}),
    };
  });

  let threshold: AgreementThreshold;
  let customThreshold: number | undefined;
  if (typeof parsed.agreementThreshold === "number") {
    threshold = thresholdFromNumber(parsed.agreementThreshold);
    // Form represents threshold as a 3-value enum (1, 0.66, 0.34). Anything
    // else round-trips through the closest preset, silently rewriting the
    // user's value. Capture it as `customThreshold` so the emitter restores
    // the exact number, and surface a lossy reason so form mode is hidden.
    const PRESETS = new Set([1, 0.66, 0.34]);
    if (!PRESETS.has(parsed.agreementThreshold)) {
      customThreshold = parsed.agreementThreshold;
      reasons.push(
        `Custom \`agreementThreshold: ${parsed.agreementThreshold}\` — form mode only offers 1.0 / 0.66 / 0.34 presets.`,
      );
    }
  } else {
    threshold = (parsed.agreementThreshold as AgreementThreshold) ?? "majority";
  }

  // Only the `review` literal is unrepresentable in the form (form has
  // auto-finalize/ask-user only). For merge/ask we let actionToDaemon do
  // the round-trip from form state on save — capturing the raw value here
  // would let it shadow a user's form edit (form picker says "ask me",
  // raw still says "merge", emitter writes "merge"). For "review" the
  // form is disabled (lossy) so capturing it is safe.
  const onThresholdMetRaw: "review" | undefined =
    parsed.onThresholdMet === "review" ? "review" : undefined;
  if (onThresholdMetRaw === "review") {
    reasons.push(
      "`onThresholdMet: review` — form mode only offers auto-finalize / ask-user.",
    );
  }

  return {
    form: {
      id: parsed.id ?? existingId,
      name: parsed.name ?? "",
      description: parsed.description ?? "",
      author: parsed.author ?? "you",
      category: deriveCategory(parsed.id ?? existingId),
      phases: phases.length > 0 ? phases : DEFAULT_FORM.phases,
      threshold,
      ...(customThreshold !== undefined ? { customThreshold } : {}),
      onThresholdMet: actionFromDaemon(parsed.onThresholdMet),
      ...(onThresholdMetRaw ? { onThresholdMetRaw } : {}),
      maxRounds: parsed.maxRounds ?? 3,
      yoloDefault: parsed.yoloDefault ?? false,
      // Flatten the daemon shape (`models: [...]`) into one form row per
      // (lineage, model) so the cockpit's add/remove UI is row-oriented.
      // Authors who want a multi-model fallback chain put them as separate
      // rows in priority order — matches how reviewer.candidates is shown.
      fallbackDoer: flattenFallbackList(parsed.fallback?.doer),
      fallbackReviewer: flattenFallbackList(parsed.fallback?.reviewer),
    },
    formLossy: reasons.length > 0,
    lossyReasons: reasons,
  };
}

/** Flatten daemon-shape fallback rows ({lineage, models[]}) into one form row
 *  per (lineage, model) tuple. The form's add/remove UI is row-oriented. */
function flattenFallbackList(
  list: Array<{ lineage?: string; models?: string[]; persona?: string }> | undefined,
): FallbackVoice[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((fb) => {
    const cockpitLineage = DAEMON_TO_COCKPIT[fb.lineage ?? ""] ?? "claude";
    const models = (fb.models ?? []).filter(
      (m) => typeof m === "string" && m.trim().length > 0,
    );
    if (models.length === 0) return [];
    return models.map((model) => ({
      lineage: cockpitLineage,
      model,
      ...(fb.persona ? { persona: fb.persona } : {}),
    }));
  });
}

function deriveCategory(id: string): Template["category"] {
  const i = id.toLowerCase();
  if (i.includes("bug") || i.includes("debug") || i.includes("diagnose")) return "debug";
  if (i.includes("plan") || i.includes("architect")) return "plan";
  if (i.includes("decide") || i.includes("decision")) return "decide";
  return "review";
}

// ─── Constants for form rendering ───────────────────────────────────────

const CATEGORIES: { id: Template["category"]; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "decide", label: "Decide" },
];

const THRESHOLDS: { id: AgreementThreshold; label: string; hint: string }[] = [
  {
    id: "unanimous",
    label: "Unanimous",
    hint: "All lineages must agree. Strictest — best for high-stakes reviews.",
  },
  {
    id: "majority",
    label: "Majority",
    hint: "≥ ⅔ of lineages agree. Good default for code review.",
  },
  {
    id: "any",
    label: "Any",
    hint: "≥1 lineage agrees. Useful for brainstorming where divergence is fine.",
  },
];

const ACTIONS: { id: ThresholdAction; label: string }[] = [
  { id: "auto-finalize", label: "Auto-finalize" },
  { id: "ask-user", label: "Ask me" },
];

// ─── Component ─────────────────────────────────────────────────────────

export interface TemplateDialogProps {
  /** When set, dialog opens in EDIT mode, populated from this template. */
  editing?: Template;
  /** Renders the trigger. New mode wraps with a "+ New template" button by default. */
  trigger?: React.ReactNode;
  /** Called after a successful save. Parent should refresh its list. */
  onSaved?: (savedId: string) => void;
}

export function TemplateDialog({
  editing,
  trigger,
  onSaved,
}: TemplateDialogProps) {
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(editing);

  // Initial form + yaml state derived from editing prop.
  // Depend on the *content* (id + yaml) rather than the object reference
  // so a parent re-render with a new Template object pointing at the same
  // template doesn't wipe in-flight dialog edits.
  const initial = useMemo(() => {
    if (!editing) return { form: DEFAULT_FORM, yaml: buildYamlFromForm(DEFAULT_FORM), lossy: false, reasons: [] };
    const parsed = parseYamlToForm(editing.yaml, editing.id);
    return {
      form: parsed.form,
      yaml: editing.yaml,
      lossy: parsed.formLossy,
      reasons: parsed.lossyReasons,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing?.yaml]);

  const [form, setForm] = useState<FormState>(initial.form);
  const [yamlText, setYamlText] = useState<string>(initial.yaml);
  const [yamlDirty, setYamlDirty] = useState(false);
  // Tracks whether the user has made any field-level edit in Form mode.
  // Without this, opening a builtin template in Form mode immediately
  // re-stringifies via buildYamlFromForm — which strips comments and
  // reformats. The server's byte-equality check (existing.yaml ===
  // yamlContent) then fails on save and the row gets promoted from
  // 'builtin' to 'user', losing all original comments + breaking the
  // builtin-resync loop. Save uses the original YAML when neither dirty
  // flag is set.
  const [formDirty, setFormDirty] = useState(false);
  const [tab, setTab] = useState<"form" | "yaml">(initial.lossy ? "yaml" : "form");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<TemplateValidationIssue[]>([]);

  // Re-seed when `editing` prop changes.
  useEffect(() => {
    setForm(initial.form);
    setYamlText(initial.yaml);
    setYamlDirty(false);
    setFormDirty(false);
    setTab(initial.lossy ? "yaml" : "form");
    setSaveError(null);
    setServerIssues([]);
  }, [initial]);

  // Hold the latest `initial` in a ref so the setTimeout-based reset on
  // dialog close always reads the freshest value. Without this, save →
  // close → 200ms-later reset captured the OLD initial via closure, then
  // overwrote the new state already set by the [initial] useEffect when
  // the parent re-rendered with the saved template. Result: reopening
  // the dialog showed stale form values even though the YAML preview
  // (driven by the parent's templates list) had the new content.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Source-of-truth precedence — see selectLiveYaml docstring. Step 4
  // (return original yaml verbatim) is what prevents builtin templates
  // from being silently promoted to 'user' source via stringify-induced
  // byte drift.
  const liveYaml = selectLiveYaml({
    yamlDirty,
    tab,
    formDirty,
    yamlText,
    formYaml: buildYamlFromForm(form),
    initialYaml: initial.yaml,
  });
  const validation = useMemo(() => validateTemplateYaml(liveYaml), [liveYaml]);

  function setFormField<K extends keyof FormState>(k: K, v: FormState[K]) {
    const next = { ...form, [k]: v };
    setForm(next);
    setFormDirty(true);
    if (!yamlDirty) setYamlText(buildYamlFromForm(next));
  }

  /**
   * Switching from a dirty YAML pane back to Form would drop the YAML
   * edits silently — buildYamlFromForm(form) would overwrite them on the
   * next setFormField. Re-parse the YAML into the form first so the form
   * reflects what the user just typed, then clear yamlDirty so subsequent
   * form edits propagate normally.
   *
   * If the YAML can't be parsed back (lossy fields, syntax errors), keep
   * the user on the YAML tab — refusing to switch beats silently nuking
   * their edits.
   */
  function handleTabChange(next: "form" | "yaml") {
    if (next === "form" && yamlDirty) {
      const reparsed = parseYamlToForm(yamlText, form.id);
      if (reparsed.formLossy) {
        // Can't represent in form. Stay on YAML.
        return;
      }
      setForm(reparsed.form);
      setYamlDirty(false);
      // Promoting dirty YAML into the form counts as form-mode edits.
      // Without this, switching back to Form would render
      // buildYamlFromForm(form), drop the comments the user just edited
      // away from, and then liveYaml would fall back to initial.yaml on
      // save — losing the user's intent.
      setFormDirty(true);
    }
    setTab(next);
  }

  function reset() {
    // Read latest initial via ref — see initialRef declaration above.
    const i = initialRef.current;
    setForm(i.form);
    setYamlText(i.yaml);
    setYamlDirty(false);
    setFormDirty(false);
    setTab(i.lossy ? "yaml" : "form");
    setSaving(false);
    setSaveError(null);
    setServerIssues([]);
  }

  function handleClose(o: boolean) {
    setOpen(o);
    if (!o) setTimeout(reset, 200);
  }

  async function handleSave() {
    if (!validation.valid || saving) return;
    const idToSave = isEdit
      ? editing!.id
      : (form.id || slugify(form.name) || "untitled");
    setSaving(true);
    setSaveError(null);
    setServerIssues([]);
    try {
      const saved = await saveTemplate({
        id: idToSave,
        yaml: liveYaml,
      });
      onSaved?.(saved.id);
      handleClose(false);
    } catch (err) {
      if (err instanceof DaemonError) {
        setSaveError(err.message);
        const detailIssues =
          (err.details as { issues?: TemplateValidationIssue[] } | undefined)
            ?.issues ?? [];
        setServerIssues(detailIssues);
      } else {
        setSaveError(
          err instanceof Error ? err.message : "Save failed (unknown error)",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  // validation.valid already enforces a non-empty `name` field via the
  // TemplateSchema (z.string().min(1)). Gating on form.name additionally
  // would block raw-YAML paste in YAML mode (form.name only updates from
  // form-tab edits) — see PR #10 round-2 review finding #1.
  const canSave = validation.valid && !saving;

  const triggerEl = trigger ?? (
    <button
      type="button"
      aria-label={isEdit ? "Edit template" : "New template"}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
    >
      {isEdit ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
      <span className="hidden sm:inline">
        {isEdit ? "Edit" : "New template"}
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>{triggerEl}</DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[min(96vw,720px)] flex-col gap-0 overflow-hidden border-border bg-card p-0 shadow-2xl sm:max-w-none"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/20">
            <FileCode2 className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-[15px] font-semibold leading-tight tracking-tight">
              {isEdit ? `Edit template — ${editing!.name}` : "New template"}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              {isEdit
                ? "Edit the YAML directly or use the form. Validation runs live."
                : "A reusable review workflow. Edit visually below or paste raw YAML."}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => handleClose(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-border bg-card/40 px-6">
          <div className="-mb-px flex items-center gap-1">
            <TabButton
              active={tab === "form"}
              onClick={() => !initial.lossy && handleTabChange("form")}
              disabled={initial.lossy}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Form
              {initial.lossy && (
                <span className="ml-1 rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground">
                  YAML only
                </span>
              )}
            </TabButton>
            <TabButton active={tab === "yaml"} onClick={() => handleTabChange("yaml")}>
              <FileCode2 className="h-3.5 w-3.5" />
              YAML
              {!validation.valid && tab === "form" && (
                <span className="ml-1 h-1.5 w-1.5 rounded-full bg-destructive" />
              )}
            </TabButton>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {initial.lossy && tab === "yaml" && (
            <div className="border-b border-amber-500/30 bg-amber-500/5 px-6 py-2.5 text-[11px] text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">Form editing disabled for this template</div>
                  <ul className="mt-1 space-y-0.5 leading-snug">
                    {initial.reasons.map((r, i) => (
                      <li key={i}>· {r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {tab === "form" ? (
            <FormPanel form={form} setField={setFormField} />
          ) : (
            <YamlPanel
              yaml={yamlText}
              filename={`${form.id || slugify(form.name) || "untitled"}.yaml`}
              issues={validation.issues}
              onChange={(v) => {
                setYamlText(v);
                setYamlDirty(true);
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 border-t border-border bg-card/40 px-6 py-3">
          {saveError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">Save failed</div>
                  <div className="mt-0.5 leading-snug">{saveError}</div>
                  {serverIssues.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {serverIssues.slice(0, 5).map((i, idx) => (
                        <li key={idx}>
                          <span className="font-mono">{i.path}</span>: {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {validation.valid ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  <span>Ready to save</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3 text-destructive/80" />
                  <span>
                    {validation.issues.length}{" "}
                    {validation.issues.length === 1 ? "issue" : "issues"} to resolve
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="h-9 rounded-md border border-border bg-card px-4 text-sm font-medium text-muted-foreground transition hover:border-muted-foreground/30 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={handleSave}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm font-medium shadow-sm transition",
                  canSave
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "cursor-not-allowed bg-muted text-muted-foreground/60 shadow-none",
                )}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? "Saving…" : isEdit ? "Save changes" : "Save template"}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Backwards compat — old import paths still work.
export function NewTemplateDialog(props: { onSaved?: (id: string) => void }) {
  return <TemplateDialog onSaved={props.onSaved} />;
}

// ─── Internal building blocks ───────────────────────────────────────────

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative flex items-center gap-1.5 rounded-t-md px-3 py-2.5 text-sm font-medium transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/50"
          : active
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {active && !disabled && (
        <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />
      )}
    </button>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-md border px-3 text-xs font-medium transition",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-border bg-card text-muted-foreground hover:border-muted-foreground/30 hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ─── Wizard ─────────────────────────────────────────────────────────────
//
// FormPanel is a 4-step wizard. Walking the user through {basics → phases →
// fallback → quorum} keeps each screen short enough to scan and lets us
// gate Next on per-step validation (required name, ≥1 reviewer per phase,
// etc.). The same component renders both the New and the Edit dialog so
// the field surfaces stay in lockstep — there's no separate "edit" form to
// drift from "new".
//
// Save (in the parent dialog footer) is gated by the global YAML
// validation; the wizard's Next/Back is independent — power users can land
// on the last step and click Save without walking every screen.

interface StepDef {
  id: 1 | 2 | 3 | 4;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const WIZARD_STEPS: StepDef[] = [
  { id: 1, label: "Basics", icon: Tag },
  { id: 2, label: "Phases", icon: Layers },
  { id: 3, label: "Fallback", icon: Shuffle },
  // "Policy" — covers threshold + iteration (maxRounds) + gates (yolo).
  // Was "Quorum" but that collided with PhaseEditor's per-phase Approvals
  // section (reviewer.require + crossLineage); the only quorum-shaped
  // thing here is the threshold preset, the rest is run policy.
  { id: 4, label: "Policy", icon: Sliders },
];

function validateStep(step: number, form: FormState): string[] {
  const issues: string[] = [];
  if (step === 1) {
    if (!form.name || form.name.trim().length === 0) {
      issues.push("Name is required.");
    } else if (form.name.length > 80) {
      issues.push("Name is too long (max 80 chars).");
    }
    if (!form.description || form.description.trim().length === 0) {
      issues.push("Description is required — one line on when to use this template.");
    }
  } else if (step === 2) {
    if (form.phases.length === 0) {
      issues.push("At least one phase is required.");
    }
    for (const phase of form.phases) {
      if (!phase.id || phase.id.trim().length === 0) {
        issues.push(`Phase "${phase.name || "(unnamed)"}" needs an id.`);
      }
      if (phase.kind !== "review_only" && (!phase.doer.lineage || phase.doer.models.length === 0)) {
        issues.push(`Phase "${phase.name || phase.id}" needs a doer lineage + model.`);
      }
      if (phase.reviewer.candidates.length === 0) {
        issues.push(`Phase "${phase.name || phase.id}" needs at least one reviewer.`);
      }
    }
  }
  // Steps 3 (Fallback) + 4 (Policy) are optional — no required fields.
  return issues;
}

function FormPanel({
  form,
  setField,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  // Errors only show when the user TRIED to advance past a step with issues —
  // not from the moment the dialog opens. Keeps the form quiet for power
  // users who fill top-down.
  const [showErrors, setShowErrors] = useState(false);

  const issues = validateStep(step, form);
  const canAdvance = issues.length === 0;

  const goNext = () => {
    if (!canAdvance) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (step < 4) setStep(((step + 1) as 1 | 2 | 3 | 4));
  };
  const goBack = () => {
    setShowErrors(false);
    if (step > 1) setStep(((step - 1) as 1 | 2 | 3 | 4));
  };
  const goTo = (target: 1 | 2 | 3 | 4) => {
    // Allow direct jumps backward freely; forward jumps require all
    // intermediate steps to validate.
    if (target <= step) {
      setShowErrors(false);
      setStep(target);
      return;
    }
    for (let s = step; s < target; s++) {
      if (validateStep(s, form).length > 0) {
        setShowErrors(true);
        return;
      }
    }
    setShowErrors(false);
    setStep(target);
  };

  return (
    <div className="flex h-full flex-col px-6 py-6">
      <StepIndicator currentStep={step} onJump={goTo} form={form} />

      <div className="mt-6 flex-1 space-y-6">
        {step === 1 && (
          <BasicsStep form={form} setField={setField} showErrors={showErrors} />
        )}
        {step === 2 && (
          <PhasesStep form={form} setField={setField} showErrors={showErrors} />
        )}
        {step === 3 && <FallbackStep form={form} setField={setField} />}
        {step === 4 && <PolicyStep form={form} setField={setField} />}
      </div>

      {showErrors && issues.length > 0 && (
        <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <div className="mb-1 font-medium">Resolve these to continue:</div>
          <ul className="space-y-0.5 pl-4">
            {issues.map((i) => (
              <li key={i} className="list-disc">
                {i}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 1}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-muted-foreground transition hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <span className="text-[11px] text-muted-foreground">
          Step {step} of 4 · {WIZARD_STEPS[step - 1].label}
        </span>
        {step < 4 ? (
          <button
            type="button"
            onClick={goNext}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium shadow-sm transition",
              canAdvance
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground/60",
            )}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span className="text-[11px] text-emerald-300">
            <CheckCircle2 className="mr-1 inline-block h-3 w-3" />
            Save in the footer below
          </span>
        )}
      </div>
    </div>
  );
}

function StepIndicator({
  currentStep,
  onJump,
  form,
}: {
  currentStep: 1 | 2 | 3 | 4;
  onJump: (n: 1 | 2 | 3 | 4) => void;
  form: FormState;
}) {
  return (
    <div className="flex items-stretch gap-2">
      {WIZARD_STEPS.map((s) => {
        const Icon = s.icon;
        const isActive = s.id === currentStep;
        const stepIssues = validateStep(s.id, form);
        const valid = stepIssues.length === 0;
        const isPast = s.id < currentStep;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onJump(s.id)}
            className={cn(
              "flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-left transition",
              isActive
                ? "border-primary/60 bg-primary/10"
                : isPast && !valid
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-border bg-card hover:border-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-mono",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isPast && valid
                    ? "bg-emerald-500/20 text-emerald-300"
                    : isPast && !valid
                      ? "bg-destructive/20 text-destructive"
                      : "bg-muted text-muted-foreground",
              )}
            >
              {isPast && valid ? "✓" : s.id}
            </span>
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="hidden text-xs font-medium sm:inline">
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BasicsStep({
  form,
  setField,
  showErrors,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  showErrors: boolean;
}) {
  const nameInvalid = showErrors && form.name.trim().length === 0;
  const descInvalid = showErrors && form.description.trim().length === 0;
  return (
    <>
      <Field label="Name *" htmlFor="tpl-name">
        <input
          id="tpl-name"
          value={form.name}
          onChange={(e) => setField("name", e.target.value)}
          placeholder="security-audit"
          aria-invalid={nameInvalid}
          className={cn(
            "h-10 w-full rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2",
            nameInvalid
              ? "border-destructive/60 focus:border-destructive focus:ring-destructive/30"
              : "border-border focus:border-primary/60 focus:ring-primary/20",
          )}
        />
        {nameInvalid && (
          <p className="text-[11px] text-destructive">Name is required.</p>
        )}
      </Field>

      <Field
        label="Description *"
        htmlFor="tpl-desc"
        hint="One sentence on when someone should reach for this template."
      >
        <textarea
          id="tpl-desc"
          value={form.description}
          onChange={(e) => setField("description", e.target.value)}
          placeholder="Independent security audit from 3 model families…"
          rows={2}
          aria-invalid={descInvalid}
          className={cn(
            "w-full resize-none rounded-md border bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2",
            descInvalid
              ? "border-destructive/60 focus:border-destructive focus:ring-destructive/30"
              : "border-border focus:border-primary/60 focus:ring-primary/20",
          )}
        />
        {descInvalid && (
          <p className="text-[11px] text-destructive">Description is required.</p>
        )}
      </Field>

      <Field label="Category">
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <Chip
              key={c.id}
              active={c.id === form.category}
              onClick={() => setField("category", c.id)}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </Field>
    </>
  );
}

function PhasesStep({
  form,
  setField,
  showErrors,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  showErrors: boolean;
}) {
  // PhaseEditor surfaces its own per-phase errors — but on validation
  // failure show a small banner reminding the user the issue is in here.
  const issues = validateStep(2, form);
  return (
    <>
      {showErrors && issues.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {issues[0]}
        </div>
      )}
      <PhaseEditor
        phases={form.phases}
        onChange={(phases) => setField("phases", phases)}
      />
    </>
  );
}

function FallbackStep({
  form,
  setField,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  // Same hook the PhaseEditor uses — fetch enabled voices once, bucket by
  // cockpit lineage. Lets the model dropdown show ONLY models the user
  // actually has connected for the selected lineage.
  const connectedVoices = useConnectedVoices();
  return (
    <>
      <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 text-foreground">
          <Shuffle className="h-3 w-3" />
          <span className="text-[12px] font-medium">
            Template-level fallback chains
          </span>
        </div>
        Tried in order whenever a slot exhausts its own per-slot model chain.
        Same-lineage only (cross-lineage swap lands in v0.8). Strict
        <span className="font-mono"> (lineage, model)</span> dedup —
        if your reviewers already include kimi, a kimi fallback is skipped
        when another reviewer fails.
      </div>

      <FallbackList
        title="Doer fallback"
        hint="Engaged when the doer's primary + per-slot models all fail."
        rows={form.fallbackDoer}
        onChange={(rows) => setField("fallbackDoer", rows)}
        connectedVoices={connectedVoices}
      />

      <FallbackList
        title="Reviewer fallback"
        hint="Engaged when any reviewer's primary + per-slot models all fail."
        rows={form.fallbackReviewer}
        onChange={(rows) => setField("fallbackReviewer", rows)}
        connectedVoices={connectedVoices}
      />
    </>
  );
}

function FallbackList({
  title,
  hint,
  rows,
  onChange,
  connectedVoices,
}: {
  title: string;
  hint: string;
  rows: FallbackVoice[];
  onChange: (rows: FallbackVoice[]) => void;
  connectedVoices: ConnectedVoiceMap;
}) {
  const addRow = () => {
    // Default lineage = first one with at least one connected model so the
    // model dropdown isn't empty on first add. Falls back to "claude" if
    // nothing is connected yet (user can still pick a different lineage and
    // see the empty-state hint).
    const firstConnected = (
      ["claude", "codex", "gemini", "opencode", "kimi", "openrouter"] as const
    ).find((l) => (connectedVoices.byLineage[l] ?? []).length > 0);
    const lineage: ReviewerLineage = firstConnected ?? "claude";
    const firstModel = connectedVoices.byLineage[lineage]?.[0] ?? "";
    onChange([...rows, { lineage, model: firstModel }]);
  };
  const removeRow = (idx: number) => {
    onChange(rows.filter((_, i) => i !== idx));
  };
  const updateRow = (idx: number, patch: Partial<FallbackVoice>) => {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  // Auto-pick the first model for the lineage when the user switches
  // lineage on a row whose current model isn't valid for the new lineage.
  // Without this the row could keep e.g. "claude-opus-4-7" after switching
  // to opencode, which would fail at runtime with "model not enabled".
  const updateLineage = (idx: number, nextLineage: ReviewerLineage) => {
    const models = connectedVoices.byLineage[nextLineage] ?? [];
    const currentModel = rows[idx].model;
    const keepModel = models.includes(currentModel);
    updateRow(idx, {
      lineage: nextLineage,
      model: keepModel ? currentModel : (models[0] ?? ""),
    });
  };
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-[13px] font-semibold tracking-tight">{title}</h4>
        <button
          type="button"
          onClick={addRow}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-primary"
        >
          <Plus className="h-3 w-3" />
          Add fallback
        </button>
      </div>
      <p className="mb-3 text-[11px] leading-snug text-muted-foreground/80">
        {hint}
      </p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 bg-background/30 px-3 py-4 text-center text-[11px] text-muted-foreground">
          None set — slot will fail its phase if the per-slot chain exhausts.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, idx) => {
            const lineageModels =
              connectedVoices.byLineage[row.lineage] ?? [];
            // If the row's stored model isn't in the connected list, surface
            // it as a "(stored)" option so editing an existing template
            // doesn't silently lose the value when a model is no longer
            // enabled. Same trick the PhaseEditor uses.
            const modelHasOption =
              row.model.length === 0 || lineageModels.includes(row.model);
            return (
              <li key={idx} className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card font-mono text-[10px] text-muted-foreground">
                  {idx + 1}
                </span>
                <select
                  value={row.lineage}
                  onChange={(e) =>
                    updateLineage(idx, e.target.value as ReviewerLineage)
                  }
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  {(
                    [
                      "claude",
                      "codex",
                      "gemini",
                      "opencode",
                      "kimi",
                      "openrouter",
                    ] as const
                  ).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <select
                  value={row.model}
                  onChange={(e) => updateRow(idx, { model: e.target.value })}
                  className="h-8 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/20"
                >
                  {lineageModels.length === 0 && (
                    <option value="" disabled>
                      {connectedVoices.loaded
                        ? `No ${row.lineage} models enabled — open Connect → ${row.lineage}`
                        : "loading…"}
                    </option>
                  )}
                  {lineageModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {!modelHasOption && row.model.length > 0 && (
                    <option value={row.model}>{row.model} (stored)</option>
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  aria-label={`Remove fallback ${idx + 1}`}
                  className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PolicyStep({
  form,
  setField,
}: {
  form: FormState;
  setField: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <h3 className="mb-3 text-[13px] font-semibold tracking-tight">
        Across all phases
      </h3>

      <div className="mb-4">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          Agreement threshold (per review-style phase)
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THRESHOLDS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setField("threshold", t.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left transition",
                form.threshold === t.id
                  ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                  : "border-border bg-card hover:border-muted-foreground/30 hover:bg-accent/40",
              )}
            >
              <div className="text-xs font-medium">{t.label}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground/80">
          {THRESHOLDS.find((t) => t.id === form.threshold)?.hint}
        </p>
      </div>

      <div className="mb-4">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          When threshold is met
        </div>
        <div className="grid grid-cols-2 gap-2">
          {ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setField("onThresholdMet", a.id)}
              className={cn(
                "rounded-md border px-3 py-2 text-left transition",
                form.onThresholdMet === a.id
                  ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                  : "border-border bg-card hover:border-muted-foreground/30 hover:bg-accent/40",
              )}
            >
              <div className="text-xs font-medium">{a.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-muted-foreground">
            Max revise rounds (per phase)
          </span>
          <span className="font-mono text-xs text-foreground">
            {form.maxRounds}
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={form.maxRounds}
          onChange={(e) => setField("maxRounds", parseInt(e.target.value, 10))}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
      </div>

      <button
        type="button"
        onClick={() => setField("yoloDefault", !form.yoloDefault)}
        className={cn(
          "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition",
          form.yoloDefault
            ? "border-rose-500/40 bg-rose-500/5"
            : "border-border bg-card hover:border-foreground/30",
        )}
      >
        <div>
          <div className="text-xs font-medium text-foreground">
            🚀 Yolo by default
          </div>
          <div className="text-[10px] text-muted-foreground">
            Auto-approve every gate. Only flip on for trusted templates or
            trivial fixes. Cost cap still enforced.
          </div>
        </div>
        <span
          className={cn(
            "flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition",
            form.yoloDefault
              ? "border-rose-500/40 bg-rose-500/20"
              : "border-border bg-card",
          )}
        >
          <span
            className={cn(
              "h-3.5 w-3.5 rounded-full transition-transform",
              form.yoloDefault
                ? "translate-x-4 bg-rose-400"
                : "bg-muted-foreground/50",
            )}
          />
        </span>
      </button>
    </div>
  );
}

function YamlPanel({
  yaml,
  filename,
  issues,
  onChange,
}: {
  yaml: string;
  filename: string;
  issues: TemplateValidationIssue[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex h-full min-h-[400px] flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card/40 px-6 py-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {filename}
        </span>
        <ValidationBadge issues={issues} />
      </div>
      <textarea
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="flex-1 resize-none border-0 bg-background px-6 py-4 font-mono text-[12px] leading-relaxed text-foreground focus:outline-none"
      />
      {issues.length > 0 && (
        <ul className="border-t border-border bg-destructive/5 px-6 py-2.5 text-[11px] text-destructive">
          {issues.map((i, idx) => (
            <li key={idx} className="flex items-start gap-1.5 leading-snug">
              <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
              <span>
                <span className="font-mono">{i.path}</span>
                {typeof i.line === "number" && ` (line ${i.line})`}: {i.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ValidationBadge({ issues }: { issues: TemplateValidationIssue[] }) {
  if (issues.length === 0) {
    return (
      <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Valid
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
      <AlertTriangle className="h-3 w-3" />
      {issues.length} {issues.length === 1 ? "issue" : "issues"}
    </span>
  );
}
