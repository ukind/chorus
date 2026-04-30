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

// Re-export shims for direct access if needed
export { claudeShim, codexShim, geminiShim, opencodeShim, kimiShim };
