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

    // Map sandbox profile to gemini's approval-mode. Never use yolo —
    // see feedback_gemini_yolo_dangerous.md (auto_edit is safe-by-default).
    let approvalMode = 'auto_edit';
    if (opts.sandbox === 'strict') approvalMode = 'default';
    // 'workspace' (default) and 'full' both use auto_edit. Going beyond
    // auto_edit (i.e. yolo) is intentionally NOT supported here — the user
    // who wants gemini fully unsandboxed can run gemini outside chorus.

    let cmd = `cd ${cwd} && gemini --approval-mode ${approvalMode}`;

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
