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
 * Ensure CODEX_HOME exists for the given accountId.
 * If missing, create dir and copy config.toml from ~/.codex/ (NOT auth.json).
 * Never copies auth.json — defeats the purpose of per-account isolation.
 * First launch must run `codex login` to create its own auth.json.
 */
function ensureCodexHome(accountId: string): string {
  const homeDir = os.homedir();
  const codexDir = path.join(homeDir, `.codex-${accountId}`);

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });

    // Copy config.toml from ~/.codex/ if it exists
    const defaultConfigPath = path.join(homeDir, '.codex', 'config.toml');
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

    const codexHome = ensureCodexHome(opts.accountId ?? 'default');
    // Pre-trust the chat dir so Codex skips its first-launch trust prompt.
    preTrustCodexWorkspace(codexHome, opts.cwd);

    const cwd = quotePath(opts.cwd);
    const flags: string[] = [];

    // Transport-aware sandbox modes
    if (opts.transport === 'github') {
      // github transport needs network for `gh` CLI calls
      flags.push('-c', 'sandbox_workspace_write.network_access=true');
    }
    // Default (folder | tmux) keeps strict workspace-write: no network, no writes outside cwd

    if (opts.unsandboxed) {
      // Pre-approved sandbox bypass
      flags.push('--dangerously-bypass-approvals-and-sandbox');
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
