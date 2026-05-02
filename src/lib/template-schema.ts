import { z } from 'zod';

/**
 * Single phase within a template.
 *
 * Two phase shapes share the schema:
 *
 *   - Standard phases (kind: plan | spec | tests | implement | review |
 *     verify | divergence): doer required, optional reviewer, iterate
 *     loop with rounds. The runner spawns the doer, then any reviewers,
 *     then loops on disagreement up to maxRounds.
 *
 *   - Review-only phase (kind: review_only): NO doer block. The artifact
 *     is supplied at chat-create time and written into the doer answer
 *     slot synthetically. iterate is ignored — review-only is always one
 *     pass. ship is also auto-skipped (no doer diff to commit).
 *
 * The two are unified into one PhaseSchema via a discriminated union on
 * `kind`. Templates pick exactly one shape per phase and the runner
 * branches on the discriminator.
 */
/**
 * Default per-phase wait budget for the headless transport, used when a
 * template doesn't override `timeoutMs`. Headless wraps a streaming
 * subprocess; 10 min is the spawn-level wall.
 */
export const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default per-phase wait budget for the tmux file-watch path. Tighter
 * than headless because the tmux flow polls a file the CLI is writing
 * via a TUI — if 5 min pass with no answer.md content the CLI is almost
 * certainly stuck on a prompt or has crashed silently. A template's
 * `phase.timeoutMs` override beats this default on either transport.
 */
export const DEFAULT_TMUX_PHASE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Bounds on the optional per-phase timeout override.
 * 30s floor catches typos; 1h ceiling catches misconfigs that would let a
 * runaway CLI sit forever. A template that legitimately needs longer can
 * be raised here, but anything beyond an hour is almost certainly a bug.
 */
const PHASE_TIMEOUT_MIN_MS = 30_000;
const PHASE_TIMEOUT_MAX_MS = 60 * 60 * 1000;

const PhaseTimeoutSchema = z
  .number()
  .int()
  .min(PHASE_TIMEOUT_MIN_MS)
  .max(PHASE_TIMEOUT_MAX_MS)
  .optional();

const lineageEnum = z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot', 'any']);
const reviewerLineageEnum = z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot']);

const ReviewerSchema = z.object({
  require: z.number().int().min(0).default(1),
  crossLineage: z.boolean().default(true),
  candidates: z.array(z.object({
    lineage: reviewerLineageEnum,
    models: z.array(z.string()).optional(),
  })),
});

const InputsSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
}).default({ include: [], exclude: [] });

const IterateSchema = z.object({
  maxRounds: z.number().int().min(1).default(2),
  onDisagreement: z.enum(['continue', 'escalate', 'accept-doer']).default('continue'),
  // Reuse the same tmux session across rounds 1..N of THIS phase.
  // Default true = save tokens (LLM keeps context in its session).
  // Set false when a fresh perspective per round matters more than cost.
  shareSessionAcrossRounds: z.boolean().default(true),
  // Reuse this phase's tmux session for the NEXT phase too.
  // Default false = fresh session per phase boundary (different artifacts).
  // Rare to enable; only when phases are tightly coupled and context-sharing helps.
  shareSessionAcrossPhases: z.boolean().default(false),
}).default({
  maxRounds: 2,
  onDisagreement: 'continue',
  shareSessionAcrossRounds: true,
  shareSessionAcrossPhases: false,
});

/**
 * Standard phase: doer + optional reviewers + iterate loop.
 */
const StandardPhaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence']),
  title: z.string().min(1),
  description: z.string().optional(),

  doer: z.object({
    lineage: lineageEnum,
    models: z.array(z.string()).optional(),
  }),

  reviewer: ReviewerSchema.optional(),

  inputs: InputsSchema,

  iterate: IterateSchema,

  /**
   * Optional hard wait budget for both the doer subprocess and each
   * reviewer subprocess in this phase. When unset, the runner falls back
   * to DEFAULT_PHASE_TIMEOUT_MS. Bounds: 30s ≤ timeoutMs ≤ 1h.
   */
  timeoutMs: PhaseTimeoutSchema,
});

/**
 * Review-only phase: artifact supplied at runtime, no doer, single pass.
 *
 * The `artifact` block carries cockpit hints (label, hint placeholder) and
 * a hard size cap that the chat-create endpoint enforces. iterate is
 * deliberately omitted — review-only is always one round, and surfacing
 * iterate would imply the runner could loop, which it can't.
 */
const ReviewOnlyPhaseSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('review_only'),
  title: z.string().min(1),
  description: z.string().optional(),

  reviewer: ReviewerSchema,

  artifact: z.object({
    label: z.string().min(1).default('Artifact to review'),
    hint: z.string().default('Paste a unified diff, a markdown draft, code, or any text blob.'),
    // 1 MiB default cap. Anything larger is rejected at chat-create time.
    maxBytes: z.number().int().min(1).default(1024 * 1024),
  }).default({
    label: 'Artifact to review',
    hint: 'Paste a unified diff, a markdown draft, code, or any text blob.',
    maxBytes: 1024 * 1024,
  }),

  inputs: InputsSchema,

  /** Same per-phase override as standard phases; applies to all reviewers. */
  timeoutMs: PhaseTimeoutSchema,
});

export const PhaseSchema = z.discriminatedUnion('kind', [
  StandardPhaseSchema.extend({ kind: z.literal('plan') }),
  StandardPhaseSchema.extend({ kind: z.literal('spec') }),
  StandardPhaseSchema.extend({ kind: z.literal('tests') }),
  StandardPhaseSchema.extend({ kind: z.literal('implement') }),
  StandardPhaseSchema.extend({ kind: z.literal('review') }),
  StandardPhaseSchema.extend({ kind: z.literal('verify') }),
  StandardPhaseSchema.extend({ kind: z.literal('divergence') }),
  ReviewOnlyPhaseSchema,
]);

export type Phase = z.infer<typeof PhaseSchema>;
export type StandardPhase = z.infer<typeof StandardPhaseSchema> & { kind: Exclude<Phase['kind'], 'review_only'> };
export type ReviewOnlyPhase = z.infer<typeof ReviewOnlyPhaseSchema>;

/**
 * Type guard: is this phase a review-only phase?
 *
 * Centralised so callers don't repeat the literal check. Also gives the
 * compiler a narrowing hook so `phase.artifact` is type-safe inside the
 * branch (and `phase.doer` is type-safe outside it).
 */
export function isReviewOnlyPhase(phase: Phase): phase is ReviewOnlyPhase {
  return phase.kind === 'review_only';
}

/**
 * A built-in or user-authored template.
 * Defines the workflow: phases, agreement threshold, and escalation policy.
 */
export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  author: z.string().default('chorus'),

  // Agreement policy
  agreementThreshold: z.number().min(0).max(1).default(0.66),
  onThresholdMet: z.enum(['merge', 'ask', 'review']).default('ask'),
  maxRounds: z.number().int().min(1).default(3),

  // Runtime defaults
  yoloDefault: z.boolean().default(false),

  // The workflow phases.
  //
  // Hybrid templates (review_only mixed with standard phases) are explicitly
  // out of scope for v0.5 — the chat-create endpoint only checks phases[0]
  // when deciding whether `artifact` is required, so a non-first review_only
  // phase would silently run with an empty artifact. Reject the shape at
  // parse time instead of accepting it and producing garbage reviews.
  phases: z
    .array(PhaseSchema)
    .min(1)
    .refine(
      (phases) => {
        const reviewOnlyCount = phases.filter((p) => p.kind === 'review_only').length;
        // Either all standard, or exactly one review_only that occupies the
        // entire phase list. (No partial mix; no two review_only phases —
        // multi-pass review-only is also out of scope.)
        return reviewOnlyCount === 0 || (reviewOnlyCount === 1 && phases.length === 1);
      },
      {
        message:
          'review_only phases cannot be mixed with other phase kinds and only one is allowed (hybrid templates are out of scope)',
      },
    )
    .refine(
      (phases) => {
        // Phase IDs are referenced from the runner (phase_events.phase_id,
        // chat dir layout, gate keys). Duplicates would clobber each other.
        const ids = phases.map((p) => p.id);
        return new Set(ids).size === ids.length;
      },
      {
        message: 'phase ids must be unique',
      },
    ),

  /**
   * Optional Ship phase — runs after all phases pass + reviewers agree.
   *
   * When `enabled: true` AND the chat was created with `repoPath`:
   *   1. Verify git context (gh CLI installed/authed, repoPath is a repo
   *      with a remote, base branch resolvable)
   *   2. Stage + commit doer's diff with a message from the chat
   *   3. Push the chorus branch
   *   4. `gh pr create` against baseBranch
   *   5. Stop. No auto-merge in v0.5 — human clicks Merge in GitHub UI.
   *
   * When `enabled: false` OR chat has no repoPath: phase is skipped,
   * chat ends with status=approved as before. No noise.
   *
   * On any failure (gh missing, push reject, dirty working tree, etc.):
   * chat ends with status=blocked and the failure mode in the meta.
   *
   * Note: a template whose first phase is `review_only` cannot ship — the
   * runner skips ship for those regardless of this flag (no doer diff
   * exists). The flag is allowed in the YAML so a template author can
   * write the field without the validator rejecting it; the runner is
   * the enforcement point.
   */
  ship: z
    .object({
      enabled: z.boolean().default(false),
      /** Base branch to PR against. If unset, ship.ts detects default branch. */
      baseBranch: z.string().optional(),
      /** Branch name pattern. {chatId} is substituted. */
      branchPattern: z.string().default('chorus/{chatId}'),
      /** PR title template. {template} {chatId} substituted. */
      titleTemplate: z.string().default('chorus: {template} via #{chatId}'),
    })
    .optional(),
});

export type Template = z.infer<typeof TemplateSchema>;

/**
 * Convenience: does the template's first phase require a runtime artifact?
 *
 * Used by the chat-create endpoint to gate the `artifact` body field and by
 * cockpit/CLI surfaces to swap UI between "task" and "artifact" affordances.
 *
 * NOTE: only the first phase is consulted. Hybrid templates (some phases
 * review_only, some not) are out of scope for v0.5 and would need a richer
 * answer.
 */
export function templateRequiresArtifact(template: Template): boolean {
  const first = template.phases[0];
  return first ? isReviewOnlyPhase(first) : false;
}
