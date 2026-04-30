/**
 * Kimi CLI (MoonshotAI) agent shim.
 *
 * Uses `--afk` flag which auto-dismisses AskUserQuestion AND auto-approves
 * tool calls. Equivalent to claude's auto-accept and codex's
 * approval_policy=never. Without it kimi shows a one-time "Allow this tool?"
 * dialog that would block a chorus-spawned reviewer indefinitely.
 *
 * If a new kimi release ever drops `--afk`, the error-detector pattern in
 * src/daemon/error-detector.ts (kind='permission_prompt') is a defense-in-
 * depth fallback — runner can capture-pane and send-keys to dismiss it.
 *
 * MCP context: kimi spawned as a reviewer doesn't talk to chorus's own MCP
 * server (that would be circular). It just reads ask.md, writes answer.md.
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';

export const kimiShim: AgentShim = {
  lineage: 'moonshot',
  name: 'kimi-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && kimi`;

    // --afk auto-dismisses prompts and auto-approves tool calls. Default ON
    // for headless reviewer spawns; user can flip via settings if they want
    // to be prompted in the kimi terminal session.
    if (opts.autoApprove !== false) {
      cmd += ` --afk`;
    }

    if (opts.model) {
      cmd += ` -m ${quoteValue(opts.model)}`;
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
    // Kimi CLI uses Moonshot subscription on the user's plan, not metered API.
    return 0;
  },
};
