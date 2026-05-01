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

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseOpencode, parseOpencodeExit } from './parsers.js';

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

  // Defense-in-depth recovery if --afk is dropped or a future kimi rev shows
  // a different prompt shape. Default highlight is "Allow once"; Right + Enter
  // navigates to "Always allow" and confirms (same UX convention as opencode).
  recoverKeys: {
    permission_prompt: ['Right', 'Enter'] as const,
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

  /**
   * Headless mode — runs Kimi K2.6 via the OpenCode CLI + OpenCode Go
   * subscription, which is the path the fleet/openbridge journals settled
   * on after the standalone `kimi` binary proved unreliable (its config
   * file is empty out of the box; users hit "LLM not set" until they
   * manually wire `[models]` in `~/.kimi/config.toml`).
   *
   * Equivalent of: `opencode run --format json --model opencode-go/kimi-k2.6
   * "<prompt>"`. Reuses the opencode JSON-blob parsers since the output
   * format is identical (it IS opencode under the hood). Heartbeat on so
   * the UI shows progress during the silent one-shot.
   *
   * Model normalisation: templates may say `kimi-k2.6` (plain) or
   * `opencode-go/kimi-k2.6` (qualified); both resolve to the latter. The
   * opencode CLI requires the `opencode-go/` prefix to route through the
   * Go subscription gateway.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const rawModel = opts.model ?? 'kimi-k2.6';
    const model = rawModel.startsWith('opencode-go/')
      ? rawModel
      : `opencode-go/${rawModel}`;

    const args = ['run', '--format', 'json', '--model', model, opts.promptText];

    const run = spawnHeadless({
      command: 'opencode',
      args,
      cwd: opts.cwd,
      parseLine: parseOpencode,
      onExit: (fullStdout) => parseOpencodeExit(fullStdout),
      cli: 'kimi',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true,
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Kimi CLI uses Moonshot subscription on the user's plan, not metered API.
    return 0;
  },
};
