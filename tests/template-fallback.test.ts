/**
 * Tests the template-level fallback chain composition (v0.7 feature).
 *
 * The runner doesn't need its own retry loop — `runWithModelFallback` already
 * walks a model list and falls through on null. `buildSlotFallbackChain`'s
 * job is to compose that list correctly: append template-level fallbacks
 * onto the slot's per-slot chain, filtered for same-lineage, deduped against
 * every active (lineage, model) in the phase.
 *
 * Critical case from the user spec (2026-05-03):
 *   reviewers=[kimi, deepseek] (both opencode lineage)
 *   template.fallback=[kimi]
 *   When deepseek fails → must NOT spawn a second kimi reviewer.
 */
import { describe, it, expect } from 'vitest';
import { buildSlotFallbackChain } from '../src/daemon/runner/template-fallback';

describe('buildSlotFallbackChain', () => {
  it('returns slot.models unchanged when no template fallback exists', () => {
    const slot = { lineage: 'opencode', models: ['kimi-k2.6'] };
    const chain = buildSlotFallbackChain(slot, [slot], undefined);
    expect(chain).toEqual(['kimi-k2.6']);
  });

  it('returns slot.models unchanged when template fallback is empty array', () => {
    const slot = { lineage: 'opencode', models: ['kimi-k2.6'] };
    const chain = buildSlotFallbackChain(slot, [slot], []);
    expect(chain).toEqual(['kimi-k2.6']);
  });

  it('appends template fallbacks of matching lineage onto the chain', () => {
    const slot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [
      { lineage: 'opencode', models: ['kimi-k2.6'] },
      { lineage: 'opencode', models: ['glm-5.1'] },
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual(['deepseek-v4-pro', 'kimi-k2.6', 'glm-5.1']);
  });

  it('skips template fallbacks of a different lineage (v0.7: same-lineage only)', () => {
    const slot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [
      { lineage: 'anthropic', models: ['claude-opus-4-7'] }, // wrong lineage
      { lineage: 'opencode', models: ['kimi-k2.6'] },
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual(['deepseek-v4-pro', 'kimi-k2.6']);
  });

  it('dedups against the slot itself — never appends the slot model again', () => {
    const slot = { lineage: 'opencode', models: ['kimi-k2.6'] };
    const fallback = [{ lineage: 'opencode', models: ['kimi-k2.6'] }];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual(['kimi-k2.6']);
  });

  it('user spec: reviewers=[kimi, deepseek] + fallback=[kimi] does not spawn duplicate kimi', () => {
    // The user's exact case from 2026-05-03. Both reviewers are opencode-lineage
    // (via opencode-go gateway). kimi as a template fallback should NOT spawn
    // a second kimi reviewer when deepseek fails (the existing kimi reviewer
    // already covers that voice).
    const kimiSlot = { lineage: 'opencode', models: ['kimi-k2.6'] };
    const deepseekSlot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [{ lineage: 'opencode', models: ['kimi-k2.6'] }];

    // Building deepseek's chain: kimi is in another active slot, must dedup.
    const deepseekChain = buildSlotFallbackChain(
      deepseekSlot,
      [kimiSlot, deepseekSlot],
      fallback,
    );
    expect(deepseekChain).toEqual(['deepseek-v4-pro']); // no kimi appended

    // Building kimi's chain: kimi is itself, must dedup.
    const kimiChain = buildSlotFallbackChain(
      kimiSlot,
      [kimiSlot, deepseekSlot],
      fallback,
    );
    expect(kimiChain).toEqual(['kimi-k2.6']);
  });

  it('extended user spec: fallback=[kimi, glm-5.1] with [kimi, deep] → both slots get glm-5.1', () => {
    // Same setup but with a second fallback row that ISN'T already active —
    // both reviewers should pick it up (after their own primary).
    const kimiSlot = { lineage: 'opencode', models: ['kimi-k2.6'] };
    const deepseekSlot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [
      { lineage: 'opencode', models: ['kimi-k2.6'] }, // dup w/ kimiSlot
      { lineage: 'opencode', models: ['glm-5.1'] }, // unique
    ];

    const deepChain = buildSlotFallbackChain(
      deepseekSlot,
      [kimiSlot, deepseekSlot],
      fallback,
    );
    expect(deepChain).toEqual(['deepseek-v4-pro', 'glm-5.1']);

    const kimiChain = buildSlotFallbackChain(
      kimiSlot,
      [kimiSlot, deepseekSlot],
      fallback,
    );
    expect(kimiChain).toEqual(['kimi-k2.6', 'glm-5.1']);
  });

  it('flattens multi-model fallback rows in priority order', () => {
    // A fallback row can list multiple models — each is appended in order.
    const slot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [
      { lineage: 'opencode', models: ['kimi-k2.6', 'glm-5.1', 'qwen3.6-plus'] },
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual([
      'deepseek-v4-pro',
      'kimi-k2.6',
      'glm-5.1',
      'qwen3.6-plus',
    ]);
  });

  it('dedups within the template fallback list itself (no double-append)', () => {
    const slot = { lineage: 'opencode', models: ['deepseek-v4-pro'] };
    const fallback = [
      { lineage: 'opencode', models: ['kimi-k2.6'] },
      { lineage: 'opencode', models: ['kimi-k2.6'] }, // duplicate row
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual(['deepseek-v4-pro', 'kimi-k2.6']);
  });

  it('handles a slot with multiple per-slot models (chains both before fallback)', () => {
    const slot = {
      lineage: 'anthropic',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
    };
    const fallback = [
      { lineage: 'anthropic', models: ['claude-haiku-4-5'] },
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual([
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('treats per-slot fallbacks as already-active — template fallback skips them', () => {
    // If the user lists claude-sonnet as both a per-slot fallback AND a
    // template fallback, the template version is a no-op (already in chain).
    const slot = {
      lineage: 'anthropic',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
    };
    const fallback = [
      { lineage: 'anthropic', models: ['claude-sonnet-4-6'] }, // already in slot.models
    ];
    const chain = buildSlotFallbackChain(slot, [slot], fallback);
    expect(chain).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
  });
});
