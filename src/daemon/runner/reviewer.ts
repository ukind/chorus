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
import type { Phase } from '../../lib/template-schema.js';
import type { AgentShim } from '../agents/types.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import { StreamFileWriter } from './stream-file-writer.js';
import { verdictFromReviewerText } from './verdict.js';
import type { RunnerEvent } from './types.js';

export async function runReviewerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: Phase;
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
    timeoutMs: 10 * 60 * 1000,
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
      } else if (event.type === 'error') {
        errored = true;
        onEvent({
          chatId,
          type: 'cli_error',
          payload: {
            phaseId: phase.id,
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
    onEvent({
      chatId,
      type: 'cli_error',
      payload: {
        phaseId: phase.id,
        round,
        role: 'reviewer',
        agent: `${agentName}-${reviewerIdx}`,
        error: {
          kind: 'stream_failure',
          message: err instanceof Error ? err.message : String(err),
          lineage: candidateLineage,
        },
      },
      ts: Date.now(),
    });
  } finally {
    writer.flushNow();
  }

  const content = finalText && finalText.length > 0 ? finalText : accumulated;
  if (errored && content.trim().length === 0) return null;
  if (content.trim().length === 0) return null;

  return verdictFromReviewerText(content);
}
