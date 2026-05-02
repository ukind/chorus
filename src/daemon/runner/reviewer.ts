/**
 * Reviewer streaming execution.
 *
 * Mirrors runDoerHeadless but returns a boolean | null verdict instead of
 * the {content, full} shape — caller (the per-chat reviewer pool) only
 * needs to know agreed / disagreed / failed.
 *
 * Tested by tests/runner-reviewer.test.ts.
 */
import * as fs from 'fs';
import type { StandardPhase } from '../../lib/template-schema.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../lib/template-schema.js';
import type { AgentShim } from '../agents/types.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import { StreamFileWriter } from './stream-file-writer.js';
import { verdictFromReviewerText } from './verdict.js';
import type { RunnerEvent } from './types.js';

export async function runReviewerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: StandardPhase;
  round: number;
  reviewerIdx: number;
  candidateLineage: string;
  candidateModel?: string;
  agentName: string;
  askContent: string;
  answerFile: string;
  reviewerDir: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
}): Promise<boolean | null> {
  const {
    shim,
    chatId,
    phase,
    round,
    reviewerIdx,
    candidateLineage,
    candidateModel,
    agentName,
    askContent,
    answerFile,
    reviewerDir,
    abortSignal,
    onEvent,
  } = args;

  if (!shim.runHeadless) return null;

  const perms = await getPermissions();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;
  // Captured from the first error event so we can write it to
  // answer.md when the subprocess dies before producing any content.
  // Without this, callers reading ~/.chorus/chats/<id>/round-N/
  // reviewer-<agent>/answer.md see a 0-byte file with no clue what
  // went wrong (opencode lock contention, codex quota, etc.).
  let errorSummary: { kind: string; message: string } | undefined;

  fs.writeFileSync(answerFile, '');
  const writer = new StreamFileWriter(answerFile);

  const stream = shim.runHeadless({
    cwd: reviewerDir,
    promptText: askContent,
    model: candidateModel,
    sandbox: perms.sandboxProfile,
    autoApprove: perms.autoApprovePrompts,
    networkAccess: perms.networkAccess,
    abortSignal,
    timeoutMs: phase.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS,
  });

  try {
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        accumulated += event.text;
        writer.write(event.text);
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            output: accumulated.slice(-500),
          },
          ts: Date.now(),
        });
      } else if (event.type === 'tool_call_start') {
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            tool: event.tool,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'progress') {
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            elapsedMs: event.elapsedMs,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'message_done') {
        finalText = event.finalText;
        // Same guard as the doer side: don't truncate accumulated deltas
        // when the CLI emits an empty `result` event (Gemini's text-then-
        // disappears bug). Only overwrite when there's real authoritative
        // text; otherwise just append the sentinel to what's already there.
        writer.flushNow();
        if (event.finalText.trim().length === 0) {
          const existing = fs.existsSync(answerFile)
            ? fs.readFileSync(answerFile, 'utf-8')
            : '';
          if (!/\n##\s*DONE\s*\n?$/i.test(existing.trimEnd())) {
            fs.appendFileSync(
              answerFile,
              existing.endsWith('\n') ? '\n## DONE\n' : '\n\n## DONE\n',
            );
          }
        } else {
          fs.writeFileSync(answerFile, `${event.finalText}\n\n## DONE\n`);
        }
        // Tell the cockpit this reviewer is fully on disk so it can
        // flip the card immediately rather than wait for the 8s polling
        // tick. Mirrored in doer.ts.
        onEvent({
          chatId,
          type: 'participant_done',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'error') {
        errored = true;
        if (!errorSummary) {
          errorSummary = { kind: event.kind, message: event.message };
        }
        onEvent({
          chatId,
          type: 'cli_error',
          payload: {
            phaseId: phase.id,
            phaseKind: phase.kind,
            phaseIdx: 0,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            error: {
              kind: event.kind,
              message: event.message,
              lineage: candidateLineage,
            },
          },
          ts: Date.now(),
        });
      }
    }
  } catch (err) {
    errored = true;
    const message = err instanceof Error ? err.message : String(err);
    if (!errorSummary) {
      errorSummary = { kind: 'stream_failure', message };
    }
    onEvent({
      chatId,
      type: 'cli_error',
      payload: {
        phaseId: phase.id,
        phaseKind: phase.kind,
        phaseIdx: 0,
        round,
        role: 'reviewer',
        agent: `${agentName}-${reviewerIdx}`,
        error: {
          kind: 'stream_failure',
          message,
          lineage: candidateLineage,
        },
      },
      ts: Date.now(),
    });
  } finally {
    writer.flushNow();
    // When the subprocess died without producing any content, write the
    // error summary to answer.md so the chat dir is self-explanatory.
    // Otherwise post-mortem inspection sees an empty file with no
    // signal — exactly the silent-failure that hid opencode-cli-2's
    // failure on the PR #10 review chat.
    if (errored && accumulated.length === 0 && (!finalText || finalText.length === 0) && errorSummary) {
      try {
        fs.writeFileSync(
          answerFile,
          `## REVIEWER FAILED\n\n` +
            `**Kind:** ${errorSummary.kind}\n` +
            `**Lineage:** ${candidateLineage}\n` +
            `**Model:** ${candidateModel ?? '(default)'}\n\n` +
            `${errorSummary.message}\n`,
        );
      } catch {
        /* best-effort — don't fail the runner because of a write error */
      }
    }
    // Mirror runDoerHeadless: surface answer.md write failures as a
    // cli_warning so the user sees "stream stopped writing" instead of
    // a quietly truncated reviewer transcript that the verdict parser
    // then chokes on.
    if (writer.isDead()) {
      const err = writer.lastError();
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'reviewer',
          agent: `${agentName}-${reviewerIdx}`,
          reason: 'stream_writer_dead',
          message: `answer.md write failed; subsequent deltas dropped: ${err ? err.message : 'unknown'}`,
          cta: 'Check disk space + permissions on ~/.chorus/chats. Re-run when fixed.',
        },
        ts: Date.now(),
      });
    }
  }

  const content = finalText && finalText.length > 0 ? finalText : accumulated;
  if (errored && content.trim().length === 0) return null;
  if (content.trim().length === 0) return null;

  return verdictFromReviewerText(content);
}
