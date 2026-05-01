/**
 * Pure prompt-construction helpers.
 *
 * Three functions that take phase config + user inputs and return the
 * ask.md text the runner pastes into the doer/reviewer CLIs. No fs writes,
 * no subprocess — just string assembly + (for packAttachedFiles) read-only
 * filesystem inspection that's exercised through tests against tmp dirs.
 *
 * Extracted out of runner.ts so the streaming hot paths can be split later
 * without breaking these contracts.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Phase } from '../../lib/template-schema.js';

// Per-file cap and total cap when inlining attached files into a prompt.
// Numbers chosen to keep prompts comfortably within Anthropic / OpenAI / Google
// 1M-token budgets while still surfacing realistic source files. Hardcoded
// for now; if template authors need larger payloads we'd lift these into
// template config (template.inputs.maxFileBytes / maxTotalBytes).
export const ATTACHED_FILE_MAX_BYTES = 64 * 1024;
export const ATTACHED_FILES_TOTAL_BYTES = 256 * 1024;

/**
 * Inline the contents of user-attached files into a single markdown block
 * the doer/reviewer can read directly. Drops files that:
 *   - traverse out of repoPath/cwd via `..` (security)
 *   - are symlinks (TOCTOU defence)
 *   - aren't regular files (sockets, fifos, etc.)
 *   - don't exist
 *   - would blow past the 256KB total cap
 *
 * Each surviving file is fenced as a markdown code block with its
 * extension as the language hint.
 */
export function packAttachedFiles(
  paths: string[] | undefined,
  repoPath: string | undefined,
): string {
  if (!paths || paths.length === 0) return '';

  const chunks: string[] = [];
  let totalBytes = 0;

  const cwdRoot = path.resolve(repoPath ?? process.cwd());

  for (const rel of paths) {
    const abs = path.resolve(
      path.isAbsolute(rel) ? rel : path.join(cwdRoot, rel),
    );
    const display = path.isAbsolute(rel) ? path.relative(cwdRoot, abs) || abs : rel;

    if (!path.isAbsolute(rel) && !abs.startsWith(cwdRoot + path.sep) && abs !== cwdRoot) {
      chunks.push(`### \`${display}\` — _path traversal rejected, skipping_`);
      continue;
    }

    if (!fs.existsSync(abs)) {
      chunks.push(`### \`${display}\` — _file not found, skipping_`);
      continue;
    }

    let body: string;
    try {
      const lstat = fs.lstatSync(abs);
      if (lstat.isSymbolicLink()) {
        chunks.push(`### \`${display}\` — _symlink rejected, skipping_`);
        continue;
      }
      if (!lstat.isFile()) {
        chunks.push(`### \`${display}\` — _not a regular file, skipping_`);
        continue;
      }
      body = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push(`### \`${display}\` — _read error: ${msg}_`);
      continue;
    }

    const truncated = body.length > ATTACHED_FILE_MAX_BYTES;
    const slice = truncated ? body.slice(0, ATTACHED_FILE_MAX_BYTES) : body;
    const remainingBudget = ATTACHED_FILES_TOTAL_BYTES - totalBytes;

    if (slice.length > remainingBudget) {
      chunks.push(
        `### \`${display}\` — _skipped: would exceed ${ATTACHED_FILES_TOTAL_BYTES}-byte total cap_`,
      );
      continue;
    }

    totalBytes += slice.length;
    const ext = path.extname(display).slice(1) || '';
    chunks.push(
      `### \`${display}\`${truncated ? ` (truncated to ${ATTACHED_FILE_MAX_BYTES} bytes)` : ''}\n\`\`\`${ext}\n${slice}\n\`\`\``,
    );
  }

  if (chunks.length === 0) return '';
  return ['## Attached files', '', ...chunks, ''].join('\n');
}

/** Build the doer ask.md prompt for one phase iteration. */
export function buildAsk(
  phase: Phase,
  _phaseIdx: number,
  round: number,
  work: string,
  inputs: Phase['inputs'],
  filesBlock: string,
): string {
  const lines: string[] = [];

  lines.push(`# Chorus task — round ${round}, phase ${phase.id}`);
  lines.push('');
  lines.push('## Your role');
  lines.push('doer');
  lines.push('');
  lines.push('## What to do');
  lines.push(phase.title);
  if (phase.description) {
    lines.push('');
    lines.push(phase.description);
  }
  lines.push('');
  lines.push("## The user's request");
  lines.push(work);
  lines.push('');

  if (filesBlock) {
    lines.push(filesBlock);
  }

  if (inputs.include && inputs.include.length > 0) {
    lines.push('## Inputs (from prior phases)');
    for (const includePhaseId of inputs.include) {
      lines.push(`- Phase ${includePhaseId}: (link to answer.md)`);
    }
    lines.push('');
  }

  if (inputs.exclude && inputs.exclude.length > 0) {
    lines.push('## Excluded (do NOT read)');
    for (const excludePhaseId of inputs.exclude) {
      lines.push(`- Phase ${excludePhaseId}: explicitly blocked`);
    }
    lines.push('');
  }

  lines.push('## How to respond');
  lines.push('Write your full answer and end with: ## DONE');

  return lines.join('\n');
}

/** Build the reviewer ask.md prompt for one phase iteration. */
export function buildReviewerAsk(
  phase: Phase,
  _phaseIdx: number,
  round: number,
  work: string,
  doerOutput: string,
  filesBlock: string,
): string {
  const lines: string[] = [];

  lines.push(`# Chorus review — round ${round}, phase ${phase.id}`);
  lines.push('');
  lines.push('## Your role');
  lines.push('reviewer');
  lines.push('');
  lines.push('## What to review');
  lines.push(phase.title);
  if (phase.description) {
    lines.push('');
    lines.push(phase.description);
  }
  lines.push('');
  lines.push("## The user's request");
  lines.push(work);
  lines.push('');

  if (filesBlock) {
    lines.push(filesBlock);
  }

  lines.push('## Artifact to review');
  lines.push('```');
  lines.push(doerOutput.slice(0, 2000));
  if (doerOutput.length > 2000) {
    lines.push('... (truncated)');
  }
  lines.push('```');
  lines.push('');
  lines.push('## Your verdict');
  lines.push(
    'Do you approve? Answer: approve or request changes, end with: ## DONE',
  );

  return lines.join('\n');
}
