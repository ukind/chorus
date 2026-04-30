/**
 * Codex CLI agent shim.
 * Per-session CODEX_HOME for parallel safety (see feedback_codex_home_per_account.md).
 * Transport-aware sandbox modes (see feedback_codex_sandbox_modes.md).
 */

import type { AgentShim, AgentSpawnOptions, AgentNudgeOptions } from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { preTrustCodexWorkspace } from './preflight.js';
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

  estimateCostUsd(): number {
    // Codex uses subscription, not per-call API billing
    return 0;
  },
};
