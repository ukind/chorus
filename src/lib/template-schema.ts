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
    lineage: z.enum(['anthropic', 'openai', 'google', 'xai', 'any']),
    models: z.array(z.string()).optional(),
  }),

  reviewer: z.object({
    require: z.number().int().min(0).default(1),
    crossLineage: z.boolean().default(true),
    candidates: z.array(z.object({
      lineage: z.enum(['anthropic', 'openai', 'google', 'xai']),
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
});

export type Template = z.infer<typeof TemplateSchema>;
