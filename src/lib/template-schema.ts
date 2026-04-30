import { z } from 'zod';

/**
 * Single phase within a template.
 *
 * Unified doer/reviewer primitive:
 * - doer: the LLM producing an artifact (plan, spec, tests, implementation, etc.)
 * - reviewer: optional cross-lineage peer reviewer(s) that gate the phase
 * - inputs: control what the doer can see (include/exclude for information asymmetry)
 * - iterate: configure retry/loopback behavior on disagreement
 */
export const PhaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence']),
  title: z.string().min(1),
  description: z.string().optional(),

  doer: z.object({
    lineage: z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot', 'any']),
    models: z.array(z.string()).optional(),
  }),

  reviewer: z.object({
    require: z.number().int().min(0).default(1),
    crossLineage: z.boolean().default(true),
    candidates: z.array(z.object({
      lineage: z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot']),
      models: z.array(z.string()).optional(),
    })),
  }).optional(),

  inputs: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }).default({ include: [], exclude: [] }),

  iterate: z.object({
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
  }),
});

export type Phase = z.infer<typeof PhaseSchema>;

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

  // The workflow phases
  phases: z.array(PhaseSchema).min(1),

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
