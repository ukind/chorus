/**
 * Gemini CLI agent shim.
 * Single-line prompts only (see feedback_gemini_multiline_prompts.md).
 * Uses --approval-mode auto_edit (never yolo, see feedback_gemini_yolo_dangerous.md).
 * File references via @/abs/path inline syntax.
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';

export const geminiShim: AgentShim = {
  lineage: 'google',
  name: 'gemini-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && gemini --approval-mode auto_edit`;

    if (opts.model) {
      cmd += ` -m ${quoteValue(opts.model)}`;
    } else {
      // Default to gemini-3.1-pro-preview (gemini-pro is not valid on current plan)
      cmd += ` -m gemini-3.1-pro-preview`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    // CRITICAL: Single-line only. Gemini submits each \n as a separate query.
    // Use @/abs/path inline syntax for file references (no plain paths).
    const sentinel = opts.expectDoneSentinel ? ' End your response with ## DONE.' : '';

    return (
      `@${opts.promptFile} Read this file and follow the <ask> XML block, ` +
      `write your full answer to ${opts.answerFile}.${sentinel}`
    );
  },

  estimateCostUsd(): number {
    // Gemini via CLI may use subscription or API key; assume 0 for now
    return 0;
  },
};
