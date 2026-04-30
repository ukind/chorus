/**
 * OpenCode agent shim (Kimi/DeepSeek via OpenCode Go plan).
 * Single-line prompts, plain text paths (see feedback_gemini_multiline_prompts.md).
 * Always /clear between rounds (see feedback_opencode_clear_always.md).
 * Never lead with `/` (slash-command) or `@` (file-attach popup).
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseOpencode, parseOpencodeExit } from './parsers.js';

export const opencodeShim: AgentShim = {
  lineage: 'opencode',
  name: 'opencode-cli',

  // clearKeys are sent by the runner via mgr.sendKeys() before nudging.
  // Pattern: Escape twice to dismiss overlays, then /clear + Enter.
  clearKeys: ['Escape', 'Escape', '/clear', 'Enter'] as const,

  // Auto-recovery for OpenCode's "Always allow" dialog (bash command, file
  // read, subagent spawn — same dialog, different trigger). Default selection
  // is "Allow once"; one Right arrow moves to "Always allow", Enter confirms.
  // The dialog persists across triggers, so this is sufficient for any of the
  // approval prompts (git diff, Read on external path, Task subagent spawn).
  recoverKeys: {
    permission_prompt: ['Right', 'Enter'] as const,
  },

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

  /**
   * Headless mode (`opencode run --format json "<prompt>"`).
   *
   * OpenCode's `run` is one-shot — emits a single JSON blob at the end with
   * the final message. parseOpencode returns [] on every line; the on-exit
   * handler parses the full blob into a message_done event. Heartbeat is on
   * so the UI shows the agent is alive during the silent run.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const args = ['run', '--format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    // Pass prompt as final positional arg.
    args.push(opts.promptText);

    const run = spawnHeadless({
      command: 'opencode',
      args,
      cwd: opts.cwd,
      parseLine: parseOpencode,
      onExit: (fullStdout) => parseOpencodeExit(fullStdout),
      cli: 'opencode',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true, // one-shot — heartbeat keeps UI alive
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // OpenCode Go subscription plan (Kimi/DeepSeek), not per-call API
    return 0;
  },
};
