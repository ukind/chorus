"use client";

import { useMemo, useState } from "react";
import {
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
  Sparkles,
  Check,
} from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import type {
  AgreementThreshold,
  ReviewerLineage,
  Template,
  TemplatePhase,
  ThresholdAction,
} from "@/lib/mock-data";
import { PhaseEditor } from "@/components/phase-editor";
import { cn } from "@/lib/utils";
import {
  UI_LINEAGE_BRAND,
  UI_LINEAGE_DEFAULT_MODEL,
  UI_LINEAGE_LABEL,
} from "@/lib/lineage-maps";

const CATEGORIES: { id: Template["category"]; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "decide", label: "Decide" },
];

const LINEAGES: {
  id: ReviewerLineage;
  label: string;
  defaultModel: string;
  dot: string;
  ring: string;
}[] = (
  ["claude", "codex", "gemini", "opencode"] as const
).map((id) => ({
  id,
  label: UI_LINEAGE_LABEL[id],
  defaultModel: UI_LINEAGE_DEFAULT_MODEL[id],
  dot: UI_LINEAGE_BRAND[id].dot,
  ring: UI_LINEAGE_BRAND[id].ring,
}));

interface FormState {
  name: string;
  description: string;
  category: Template["category"];
  phases: TemplatePhase[];
  threshold: AgreementThreshold;
  onThresholdMet: ThresholdAction;
  maxRounds: number;
  yoloDefault: boolean;
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
  name: "",
  description: "",
  category: "review",
  phases: [DEFAULT_PHASE],
  threshold: "unanimous",
  onThresholdMet: "ask-user",
  maxRounds: 3,
  yoloDefault: false,
};

const THRESHOLDS: {
  id: AgreementThreshold;
  label: string;
  hint: string;
}[] = [
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

const ACTIONS: { id: ThresholdAction; label: string; hint: string }[] = [
  {
    id: "auto-finalize",
    label: "Auto-finalize",
    hint: "Once threshold is met, mark the run done and apply the synthesis automatically.",
  },
  {
    id: "ask-user",
    label: "Ask me",
    hint: "Surface the verdict and let me decide: accept, run another round, or override.",
  },
];

function buildYamlFromForm(f: FormState): string {
  const phaseLines = f.phases
    .map((p) => {
      const incLine =
        p.inputs.include.length > 0
          ? `    inputs:\n      include: [${p.inputs.include.join(", ")}]${
              p.inputs.exclude.length > 0
                ? `\n      exclude: [${p.inputs.exclude.join(", ")}]`
                : ""
            }`
          : p.inputs.exclude.length > 0
            ? `    inputs:\n      exclude: [${p.inputs.exclude.join(", ")}]`
            : "";
      const reviewerCands =
        p.reviewer.candidates.length > 0
          ? `[${p.reviewer.candidates.join(", ")}]`
          : "[]";
      const iter = `    iterate: { max: ${p.iterate.max}, on_max: ${p.iterate.onMax}${
        p.iterate.loopbackTo ? `, loopback_to: ${p.iterate.loopbackTo}` : ""
      } }`;
      return [
        `  - id: ${p.id}`,
        `    name: ${JSON.stringify(p.name)}`,
        `    kind: ${p.kind}`,
        `    gate: ${p.gate}`,
        `    doer: { lineage: ${p.doer.lineage}, models: [${p.doer.models.join(", ")}] }`,
        `    reviewer: { require: ${p.reviewer.require}, cross_lineage: ${p.reviewer.crossLineage}, candidates: ${reviewerCands} }`,
        incLine,
        iter,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  const mode =
    f.category === "review"
      ? "implement"
      : f.category === "plan"
        ? "plan"
        : f.category === "debug"
          ? "major-bug"
          : "plan";
  return [
    `name: ${f.name || "untitled-template"}`,
    `description: ${JSON.stringify(f.description || "")}`,
    `category: ${f.category}`,
    `mode: ${mode}`,
    `phases:`,
    phaseLines,
    `quorum:`,
    `  agreement_threshold: ${f.threshold}`,
    `  on_met: ${f.onThresholdMet}`,
    `  max_rounds: ${f.maxRounds}`,
    `yolo_default: ${f.yoloDefault}`,
  ].join("\n");
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateForm(f: FormState): ValidationResult {
  const errors: string[] = [];
  if (!f.name.trim()) errors.push("Template name is required.");
  if (f.phases.length === 0) errors.push("Add at least one phase.");
  for (const [i, p] of f.phases.entries()) {
    if (!p.id.trim()) errors.push(`Phase #${i + 1} needs an id.`);
    if (!p.name.trim()) errors.push(`Phase #${i + 1} needs a name.`);
    if (
      p.reviewer.crossLineage &&
      p.reviewer.candidates.includes(p.doer.lineage)
    ) {
      errors.push(
        `Phase "${p.name}" requires cross-lineage reviewers but the doer's lineage is in the candidates pool.`,
      );
    }
    if (p.iterate.onMax === "loopback" && !p.iterate.loopbackTo) {
      errors.push(`Phase "${p.name}" loops on max but has no target.`);
    }
  }
  // Phase IDs must be unique
  const ids = f.phases.map((p) => p.id);
  if (new Set(ids).size !== ids.length) errors.push("Phase ids must be unique.");
  return { valid: errors.length === 0, errors };
}

function validateYaml(raw: string): ValidationResult {
  const errors: string[] = [];
  if (!raw.trim()) return { valid: false, errors: ["Template body is empty."] };
  const required = ["name:", "category:", "phases:"];
  for (const r of required) {
    if (!raw.includes(r)) errors.push(`Missing required key: ${r.replace(":", "")}`);
  }
  return { valid: errors.length === 0, errors };
}

export function NewTemplateDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"form" | "yaml">("form");
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [yaml, setYaml] = useState<string>(() => buildYamlFromForm(DEFAULT_FORM));
  const [yamlDirty, setYamlDirty] = useState(false);

  // Validate the form when in Form tab; validate YAML body when in YAML tab.
  const formValidation = useMemo(() => validateForm(form), [form]);
  const yamlValidation = useMemo(() => validateYaml(yaml), [yaml]);
  const validation = tab === "yaml" ? yamlValidation : formValidation;

  function setFormField<K extends keyof FormState>(k: K, v: FormState[K]) {
    const next = { ...form, [k]: v };
    setForm(next);
    if (!yamlDirty) setYaml(buildYamlFromForm(next));
  }

  function reset() {
    setForm(DEFAULT_FORM);
    setYaml(buildYamlFromForm(DEFAULT_FORM));
    setYamlDirty(false);
    setTab("form");
  }

  function handleClose(o: boolean) {
    setOpen(o);
    if (!o) setTimeout(reset, 200);
  }

  const canSave = validation.valid && form.name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="New template"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New template</span>
        </button>
      </DialogTrigger>

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
            <h2 className="text-[15px] font-semibold leading-tight tracking-tight">
              New template
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A reusable workflow for the council. Edit visually below or paste raw YAML.
            </p>
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
            <TabButton active={tab === "form"} onClick={() => setTab("form")}>
              <Sparkles className="h-3.5 w-3.5" />
              Form
            </TabButton>
            <TabButton active={tab === "yaml"} onClick={() => setTab("yaml")}>
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
          {tab === "form" ? (
            <div className="space-y-6 px-6 py-6">
              {/* Name */}
              <Field label="Name" htmlFor="tpl-name">
                <input
                  id="tpl-name"
                  value={form.name}
                  onChange={(e) => setFormField("name", e.target.value)}
                  placeholder="security-audit"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </Field>

              {/* Description */}
              <Field
                label="Description"
                htmlFor="tpl-desc"
                hint="One sentence on when someone should reach for this template."
              >
                <textarea
                  id="tpl-desc"
                  value={form.description}
                  onChange={(e) => setFormField("description", e.target.value)}
                  placeholder="Independent security audit from 3 model families…"
                  rows={2}
                  className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </Field>

              {/* Category */}
              <Field label="Category">
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map((c) => (
                    <Chip
                      key={c.id}
                      active={c.id === form.category}
                      onClick={() => setFormField("category", c.id)}
                    >
                      {c.label}
                    </Chip>
                  ))}
                </div>
              </Field>

              {/* Phase editor */}
              <PhaseEditor
                phases={form.phases}
                onChange={(phases) => setFormField("phases", phases)}
              />

              {/* Top-level quorum + yolo */}
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
                        onClick={() => setFormField("threshold", t.id)}
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
                        onClick={() => setFormField("onThresholdMet", a.id)}
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
                    onChange={(e) =>
                      setFormField("maxRounds", parseInt(e.target.value, 10))
                    }
                    className="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                  />
                </div>

                {/* Yolo default */}
                <button
                  type="button"
                  onClick={() => setFormField("yoloDefault", !form.yoloDefault)}
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
                      Auto-approve every gate. Only flip on for trusted templates
                      or trivial fixes. Cost cap still enforced.
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

              {!validation.valid && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-[11px] text-amber-200">
                  <div className="font-medium uppercase tracking-wider text-[10px] mb-1">
                    Issues to resolve
                  </div>
                  <ul className="space-y-0.5">
                    {validation.errors.map((e, i) => (
                      <li key={i}>· {e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <YamlPanel
              yaml={yaml}
              filename={`${form.name || "untitled-template"}.yaml`}
              validation={validation}
              onChange={(v) => {
                setYaml(v);
                setYamlDirty(true);
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border bg-card/40 px-6 py-3">
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
                  {validation.errors.length}{" "}
                  {validation.errors.length === 1 ? "issue" : "issues"} to resolve
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
              onClick={() => handleClose(false)}
              className={cn(
                "h-9 rounded-md px-4 text-sm font-medium shadow-sm transition",
                canSave
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground/60 shadow-none",
              )}
            >
              Save template
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Internal building blocks ───────────────────────────────────────────

function TabButton({
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
        "relative flex items-center gap-1.5 rounded-t-md px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {active && (
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
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          {hint}
        </p>
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

function LineageGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{children}</div>
  );
}

function LineageCard({
  label,
  dot,
  ring,
  active,
  onClick,
  checkable,
}: {
  label: string;
  dot: string;
  ring: string;
  active: boolean;
  onClick: () => void;
  checkable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex h-10 items-center gap-2 rounded-md border px-3 text-left text-sm transition",
        active
          ? `border-primary/60 bg-primary/10 ring-1 ${ring}`
          : "border-border bg-card hover:border-muted-foreground/30 hover:bg-accent/40",
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
      <span className={cn("flex-1 truncate", active ? "text-foreground" : "text-foreground/85")}>
        {label}
      </span>
      {checkable && (
        <span
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center rounded-full transition",
            active
              ? "bg-primary text-primary-foreground"
              : "border border-border bg-transparent",
          )}
        >
          {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      )}
    </button>
  );
}

function YamlPanel({
  yaml,
  filename,
  validation,
  onChange,
}: {
  yaml: string;
  filename: string;
  validation: ValidationResult;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex h-full min-h-[400px] flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card/40 px-6 py-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {filename}
        </span>
        <ValidationBadge result={validation} />
      </div>
      <textarea
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="flex-1 resize-none border-0 bg-background px-6 py-4 font-mono text-[12px] leading-relaxed text-foreground focus:outline-none"
      />
      {!validation.valid && (
        <ul className="border-t border-border bg-destructive/5 px-6 py-2.5 text-[11px] text-destructive">
          {validation.errors.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5 leading-snug">
              <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
              <span>{e}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ValidationBadge({ result }: { result: ValidationResult }) {
  if (result.valid) {
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
      {result.errors.length} {result.errors.length === 1 ? "issue" : "issues"}
    </span>
  );
}
