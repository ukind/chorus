/**
 * Claude Code agent shim.
 * Multi-paragraph prompts are fine; no special formatting needed.
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quoteValue, quotePath } from './quote.js';

export const claudeShim: AgentShim = {
  lineage: 'anthropic',
  name: 'claude-code',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && claude`;

    if (opts.model) {
      cmd += ` --model ${quoteValue(opts.model)}`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    const sentinel = opts.expectDoneSentinel
      ? '\n\nWhen finished, end your response with: ## DONE'
      : '';

    return (
      `${opts.task}\n\n` +
      `Read the prompt at: ${opts.promptFile}\n\n` +
      `Write your full answer to: ${opts.answerFile}${sentinel}`
    );
  },

  estimateCostUsd(): number {
    // Claude Code uses subscription, not per-call API billing
    return 0;
  },
};
