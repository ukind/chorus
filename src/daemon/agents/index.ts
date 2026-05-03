/**
 * Agent shim registry: lineage → shim implementation.
 * Each CLI lineage (anthropic, openai, google, xai) has a corresponding shim
 * that handles launch commands, prompt formatting, and cost estimation.
 */

import type { AgentRegistry, AgentShim, Lineage } from './types.js';
import { claudeShim } from './claude.js';
import { codexShim } from './codex.js';
import { geminiShim } from './gemini.js';
import { opencodeShim } from './opencode.js';
import { kimiShim } from './kimi.js';
import { openrouterShim } from './openrouter.js';

const SHIMS: Record<Lineage, AgentShim> = {
  anthropic: claudeShim,
  openai: codexShim,
  google: geminiShim,
  opencode: opencodeShim,
  moonshot: kimiShim,
  any: claudeShim, // Fallback to Claude
};

export const registry: AgentRegistry = {
  pickShim(lineage: Lineage): AgentShim {
    return SHIMS[lineage] ?? SHIMS.any;
  },

  listAvailable(): AgentShim[] {
    return Object.values(SHIMS);
  },
};

/**
 * Pick a shim taking the model id into account. When the model has the
 * `openrouter:` prefix, dispatch goes through the HTTP shim regardless of
 * the slot's declared lineage — the lineage is preserved on the voice row
 * for diversity scoring, but the actual transport is OpenRouter's
 * chat-completions API.
 *
 * Callers that have a model hint (runner doer + reviewer dispatch) should
 * use this; callers that don't (legacy paths) can keep using `registry.pickShim`.
 */
export function pickShimForVoice(lineage: Lineage, model?: string): AgentShim {
  if (model && model.startsWith('openrouter:')) return openrouterShim;
  return registry.pickShim(lineage);
}

/** True when this voice should bypass CLI-credential precheck (HTTP-auth instead). */
export function isHttpDispatchedShim(shim: AgentShim): boolean {
  return shim === openrouterShim;
}

// Re-export shims for direct access if needed
export { claudeShim, codexShim, geminiShim, opencodeShim, kimiShim, openrouterShim };
