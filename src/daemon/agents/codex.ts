/**
 * Codex CLI agent shim.
 * Per-session CODEX_HOME for parallel safety (see feedback_codex_home_per_account.md).
 * Transport-aware sandbox modes (see feedback_codex_sandbox_modes.md).
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { preTrustCodexWorkspace } from './preflight.js';
import { spawnHeadless } from '../headless.js';
import { parseCodex, parseCodexExit } from './parsers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Resolve CODEX_HOME for this spawn.
 *
 * - When `accountId` is undefined/empty: reuse the user's existing `~/.codex/`
 *   (their primary login). v0.5 single-user default — no isolation needed.
 * - When `accountId` is explicit: create/reuse `~/.codex-<accountId>/` for
 *   parallel multi-account isolation. Copies config.toml from the primary
 *   home; NEVER copies auth.json (each account must have its own login).
 */
function ensureCodexHome(accountId: string | undefined): string {
  const homeDir = os.homedir();
  const primary = path.join(homeDir, '.codex');

  if (!accountId) {
    // Single-user fast path — use the user's existing login.
    return primary;
  }

  const codexDir = path.join(homeDir, `.codex-${accountId}`);

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });

    const defaultConfigPath = path.join(primary, 'config.toml');
    const targetConfigPath = path.join(codexDir, 'config.toml');

    if (fs.existsSync(defaultConfigPath) && !fs.existsSync(targetConfigPath)) {
      const content = fs.readFileSync(defaultConfigPath, 'utf-8');
      fs.writeFileSync(targetConfigPath, content, 'utf-8');
    }

    // NOTE: NEVER copy auth.json — each CODEX_HOME must have its own.
    // First launch will prompt for `codex login`.
  }

  return codexDir;
}

export const codexShim: AgentShim = {
  lineage: 'openai',
  name: 'codex-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('accountId', opts.accountId);
    validateValue('model', opts.model);

    const codexHome = ensureCodexHome(opts.accountId);
    // Pre-trust the chat dir so Codex skips its first-launch trust prompt.
    preTrustCodexWorkspace(codexHome, opts.cwd);

    const cwd = quotePath(opts.cwd);
    const flags: string[] = [];

    // Sandbox profile from user settings (may be overridden by transport).
    if (opts.unsandboxed || opts.sandbox === 'full') {
      // Full bypass — user explicitly opted into trust-everything.
      flags.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (opts.sandbox === 'strict') {
      // Read-only — codex can't write files or shell-exec.
      flags.push('-c', 'sandbox_mode="read-only"');
    }
    // 'workspace' (default) leaves codex in its config.toml-defined
    // workspace-write mode. No flag override.

    // Network access — opt-in. github transport always needs network.
    if (opts.networkAccess || opts.transport === 'github') {
      flags.push('-c', 'sandbox_workspace_write.network_access=true');
    }

    if (opts.model) {
      flags.push('--model', quoteValue(opts.model));
    }

    const flagsStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    return `cd ${cwd} && CODEX_HOME=${quotePath(codexHome)} codex${flagsStr}`;
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
   * Headless mode (`codex exec`).
   *
   * Codex `exec` accepts a prompt on argv (or stdin if argv empty) and
   * writes plain stdout — no stream-json. parseCodex returns [] every line;
   * on exit we emit one message_done with the full stdout. Heartbeat is on
   * so the UI shows progress during the silent run.
   *
   * Sandbox flags forwarded same as the tmux path. Codex's `exec` honors
   * `-c sandbox_mode=...` and `-c sandbox_workspace_write.network_access=...`
   * the same way as the interactive command.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    validateValue('accountId', opts.accountId);
    validateValue('model', opts.model);

    const codexHome = ensureCodexHome(opts.accountId);
    preTrustCodexWorkspace(codexHome, opts.cwd);

    const args: string[] = ['exec'];

    // Chorus chat dirs aren't git repos. Without this flag codex exec
    // exits 1 with "Not inside a trusted directory" — the trust_level
    // entry in config.toml only suppresses the interactive prompt, not
    // the git-repo guard. Discovered 2026-05-01 dogfooding tri-review:
    // codex reviewers wrote 0 bytes because exec aborted pre-LLM.
    args.push('--skip-git-repo-check');

    if (opts.sandbox === 'full') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (opts.sandbox === 'strict') {
      args.push('-c', 'sandbox_mode="read-only"');
    }

    if (opts.networkAccess) {
      args.push('-c', 'sandbox_workspace_write.network_access=true');
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Codex exec accepts the prompt as the final positional arg.
    args.push(opts.promptText);

    const run = spawnHeadless({
      command: 'codex',
      args,
      cwd: opts.cwd,
      env: { CODEX_HOME: codexHome },
      parseLine: parseCodex,
      onExit: (fullStdout) => parseCodexExit(fullStdout),
      cli: 'codex',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true, // no streaming; heartbeat keeps UI alive
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Codex uses subscription, not per-call API billing
    return 0;
  },
};
