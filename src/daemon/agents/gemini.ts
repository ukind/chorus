/**
 * Gemini CLI agent shim.
 * Single-line prompts only (see feedback_gemini_multiline_prompts.md).
 * Uses --approval-mode auto_edit (never yolo, see feedback_gemini_yolo_dangerous.md).
 * File references via @/abs/path inline syntax.
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
import { parseGemini } from './parsers.js';

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

  /**
   * Headless mode (`gemini -p "<prompt>" --output-format stream-json`).
   *
   * Gemini takes the prompt on argv (not stdin) — we pass it as the -p value.
   *
   * **Multi-line prompt bug:** Gemini's -p mode hangs indefinitely when the
   * prompt contains newlines (verified 2026-04-30 with gemini-3.1-pro-preview
   * — process spawns, holds the API call, but never emits any stream-json
   * event). Mirrors the interactive-mode bug captured in
   * feedback_gemini_multiline_prompts.md. Workaround: flatten the prompt to
   * a single line before passing.
   *
   * Format verified 2026-04-30; see parseGemini for shape.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    // Flatten newlines to spaces to dodge the multi-line hang. We also collapse
    // runs of whitespace so the resulting single-line prompt stays readable
    // for Gemini and doesn't blow past argv limits with redundant spaces.
    const flatPrompt = opts.promptText
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const args = ['-p', flatPrompt, '--output-format', 'stream-json', '--skip-trust'];

    // Sandbox profile → approval-mode mapping. Never use yolo
    // (see feedback_gemini_yolo_dangerous.md — empty-content overwrites).
    if (opts.sandbox === 'strict') {
      args.push('--approval-mode', 'plan'); // read-only
    } else {
      args.push('--approval-mode', 'auto_edit');
    }

    // Model — Gemini CLI requires an explicit model on current API; default
    // to gemini-3.1-pro-preview (the verified-working model).
    args.push('-m', opts.model || 'gemini-3.1-pro-preview');

    const run = spawnHeadless({
      command: 'gemini',
      args,
      cwd: opts.cwd,
      // Gemini reads the prompt from argv, not stdin — no stdinPayload.
      env: {
        // Defense in depth: env-var trust override matches the --skip-trust flag.
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      },
      parseLine: parseGemini,
      cli: 'gemini',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: false, // streaming
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Gemini via CLI may use subscription or API key; assume 0 for now
    return 0;
  },
};
