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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseOpencode, parseOpencodeExit, parseKimi } from './parsers.js';

/**
 * Two ways to talk to Kimi K2.6:
 *
 *   - Standalone `kimi` CLI (paid Moonshot subscription) — Claude-Code-
 *     compatible, supports streaming text deltas. Requires the user to
 *     have wired `default_model` or a `[models]` block in
 *     `~/.kimi/config.toml`. Out-of-box config is empty → exits 1 with
 *     "LLM not set".
 *
 *   - `opencode run --format json --model opencode-go/kimi-k2.6` (paid
 *     OpenCode Go subscription) — same model under the hood, routed
 *     through OpenCode. JSON-Lines output; one text event per LLM
 *     message. The fleet and openbridge journals use this path.
 *
 * Most users have ONE of the two paid plans, not both. Auto-detect at
 * shim init: if standalone kimi has a model configured, use it; else
 * fall back to opencode + opencode-go. Override via env
 * `CHORUS_KIMI_TRANSPORT=kimi-cli|opencode|auto` (default auto).
 */
type KimiTransport = 'kimi-cli' | 'opencode';

let cachedTransport: KimiTransport | null = null;

function detectKimiTransport(): KimiTransport {
  if (cachedTransport) return cachedTransport;

  const override = process.env.CHORUS_KIMI_TRANSPORT;
  if (override === 'kimi-cli' || override === 'opencode') {
    cachedTransport = override;
    return override;
  }

  // Probe the standalone kimi config — non-empty `default_model` OR any
  // `[models.<name>]` table means the user has wired up a real model.
  const configPath = path.join(os.homedir(), '.kimi', 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const body = fs.readFileSync(configPath, 'utf-8');
      const defaultModel = body.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m);
      const hasDefault = defaultModel != null && defaultModel[1].length > 0;
      const hasModelsTable = /^\[models\.[A-Za-z0-9_.-]+\]/m.test(body);
      if (hasDefault || hasModelsTable) {
        cachedTransport = 'kimi-cli';
        return 'kimi-cli';
      }
    } catch {
      /* fall through */
    }
  }

  cachedTransport = 'opencode';
  return 'opencode';
}

/** Test-only — clear the cached detection so tests can switch env. */
export function _resetKimiTransportCache(): void {
  cachedTransport = null;
}

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
   * Headless mode — branches on detected transport (see top-of-file
   * comment for the kimi-cli vs opencode-go decision tree).
   *
   *   - kimi-cli: streaming `kimi --print --output-format stream-json`,
   *     parsed via parseKimi (Claude-Code-compatible JSON events).
   *
   *   - opencode: one-shot `opencode run --format json --model
   *     opencode-go/kimi-k2.6 "<prompt>"`, parsed via parseOpencode
   *     (JSON-Lines, one text event per LLM message).
   *
   * Model normalisation: templates pass `kimi-k2.6` (plain). For the
   * opencode path we prepend `opencode-go/` so the CLI routes through
   * the Go subscription gateway.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const transport = detectKimiTransport();

    if (transport === 'kimi-cli') {
      const args = ['--print', '--output-format', 'stream-json'];
      if (opts.model) args.push('-m', opts.model);
      const run = spawnHeadless({
        command: 'kimi',
        args,
        cwd: opts.cwd,
        stdinPayload: opts.promptText,
        parseLine: parseKimi,
        cli: 'kimi',
        timeoutMs: opts.timeoutMs,
        abortSignal: opts.abortSignal,
        heartbeat: false,
      });
      return run.events;
    }

    // opencode path — qualify the model with the opencode-go/ prefix.
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
