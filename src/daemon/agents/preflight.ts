/**
 * Pre-spawn hooks: prepare each CLI's local config so it doesn't stop on
 * first-launch interactive prompts that would block the runner.
 *
 * Currently handles:
 *   - Claude Code: ~/.claude.json projects.<cwd>.hasTrustDialogAccepted = true
 *   - Codex CLI: <CODEX_HOME>/config.toml [projects."<cwd>"] trust_level = "trusted"
 *
 * Gemini and OpenCode have auth-on-first-launch flows we can't paper over with
 * config; the user sets those up once during onboarding.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Mark `cwd` as trusted in ~/.claude.json so Claude Code skips the trust dialog
 * when launched there. Idempotent.
 */
export function preTrustClaudeWorkspace(cwd: string): void {
  const configPath = path.join(os.homedir(), '.claude.json');
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      // Corrupt config — skip rather than wipe the user's file.
      return;
    }
  }

  const projects = (config.projects && typeof config.projects === 'object'
    ? (config.projects as Record<string, Record<string, unknown>>)
    : {});

  const existing = projects[cwd] ?? {};
  if (existing.hasTrustDialogAccepted === true) return; // already trusted

  projects[cwd] = {
    ...existing,
    hasTrustDialogAccepted: true,
  };

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, projects }, null, 2),
    'utf-8',
  );
}

/**
 * Mark `cwd` as trusted in <CODEX_HOME>/config.toml so Codex skips its
 * trust prompt. Appends a [projects."<cwd>"] block if missing.
 */
export function preTrustCodexWorkspace(codexHome: string, cwd: string): void {
  const configPath = path.join(codexHome, 'config.toml');
  let body = '';

  if (fs.existsSync(configPath)) {
    body = fs.readFileSync(configPath, 'utf-8');
  } else {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  const marker = `[projects."${cwd}"]`;
  if (body.includes(marker)) return; // already present

  const block = `\n${marker}\ntrust_level = "trusted"\n`;
  fs.writeFileSync(configPath, body + block, 'utf-8');
}
