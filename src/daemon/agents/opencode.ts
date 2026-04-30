/**
 * OpenCode agent shim (Kimi/DeepSeek via OpenCode Go plan).
 * Single-line prompts, plain text paths (see feedback_gemini_multiline_prompts.md).
 * Always /clear between rounds (see feedback_opencode_clear_always.md).
 * Never lead with `/` (slash-command) or `@` (file-attach popup).
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quotePath, validateValue } from './quote.js';

export const opencodeShim: AgentShim = {
  lineage: 'opencode',
  name: 'opencode-cli',

  // clearKeys are sent by the runner via mgr.sendKeys() before nudging.
  // Pattern: Escape twice to dismiss overlays, then /clear + Enter.
  clearKeys: ['Escape', 'Escape', '/clear', 'Enter'] as const,

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && opencode`;

    if (opts.model) {
      cmd += ` --model ${opts.model}`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    // CRITICAL: Single-line only. Never lead with `/` or `@`.
    // Plain text path reference: "at /abs/path" form.
    const sentinel = opts.expectDoneSentinel ? ' End with ## DONE.' : '';

    return (
      `Open the file at this absolute path using your read tool: ${opts.promptFile} ` +
      `— follow the <ask> block, write your full answer to ${opts.answerFile}.${sentinel}`
    );
  },

  estimateCostUsd(): number {
    // OpenCode Go subscription plan (Kimi/DeepSeek), not per-call API
    return 0;
  },
};
