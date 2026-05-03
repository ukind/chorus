import { Layers, Shuffle, Sliders, Tag } from "lucide-react";
import type {
  AgreementThreshold,
  ReviewerLineage,
  Template,
  TemplatePhase,
  ThresholdAction,
} from "@/lib/cockpit-types";
import type { FormState } from "./types";

export const COCKPIT_TO_DAEMON: Record<ReviewerLineage, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
  kimi: "moonshot",
  // openrouter voices carry an explicit `openrouter:<model>` id; the
  // template's lineage records the underlying lineage so diversity
  // scoring works. The "openrouter" UI lineage is for run-page rendering
  // only — not a daemon-side template lineage.
  openrouter: "openrouter",
};

// `xai` is a legacy alias from older templates that grouped under cockpit
// "opencode".
export const DAEMON_TO_COCKPIT: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
  xai: "opencode",
};

export const DAEMON_DEFAULT_MODEL: Record<ReviewerLineage, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview",
  opencode: "kimi-k2.6",
  kimi: "kimi-k2.6",
  openrouter: "",
};

export const DEFAULT_PHASE: TemplatePhase = {
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

export const DEFAULT_FORM: FormState = {
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

export const CATEGORIES: { id: Template["category"]; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
  { id: "debug", label: "Debug" },
  { id: "decide", label: "Decide" },
];

export const THRESHOLDS: { id: AgreementThreshold; label: string; hint: string }[] = [
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

export const ACTIONS: { id: ThresholdAction; label: string }[] = [
  { id: "auto-finalize", label: "Auto-finalize" },
  { id: "ask-user", label: "Ask me" },
];

export interface StepDef {
  id: 1 | 2 | 3 | 4;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// "Policy" covers threshold + iteration (maxRounds) + gates (yolo). The
// only quorum-shaped thing here is the threshold preset; the rest is
// run policy. PhaseEditor's per-phase Approvals section already covers
// reviewer.require + crossLineage.
export const WIZARD_STEPS: StepDef[] = [
  { id: 1, label: "Basics", icon: Tag },
  { id: 2, label: "Phases", icon: Layers },
  { id: 3, label: "Fallback", icon: Shuffle },
  { id: 4, label: "Policy", icon: Sliders },
];

export const FALLBACK_LINEAGES = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "kimi",
  "openrouter",
] as const satisfies readonly ReviewerLineage[];
