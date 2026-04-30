/**
 * Claude Code agent shim.
 * Multi-paragraph prompts are fine; no special formatting needed.
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quoteValue, quotePath } from './quote.js';
import { preTrustClaudeWorkspace } from './preflight.js';

export const claudeShim: AgentShim = {
  lineage: 'anthropic',
  name: 'claude-code',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    // Pre-trust the chat dir so Claude Code doesn't stop on its first-launch
    // "Trust this folder?" prompt. Idempotent; safe to call every spawn.
    preTrustClaudeWorkspace(opts.cwd);

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && claude`;

    // Sandbox profile mapping. Claude Code itself doesn't expose a
    // workspace-vs-strict toggle — the existing per-tool permission allow-list
    // (settings.local.json `permissions.allow[]`) already implements the
    // "workspace" profile. Full = bypass everything; strict isn't expressible
    // at spawn time, only via tighter allow-list.
    if (opts.unsandboxed || opts.sandbox === 'full') {
      cmd += ` --dangerously-skip-permissions`;
    }

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
