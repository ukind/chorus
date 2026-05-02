/**
 * Doer streaming execution.
 *
 * Drives one doer subprocess via its AgentShim's runHeadless iterator,
 * forwarding text_delta events to a buffered StreamFileWriter and to the
 * SSE bus, and producing the final `{content, full}` shape the phase
 * loop consumes.
 *
 * Critical invariants (covered by tests/runner-doer.test.ts):
 *   - text_delta events accumulate AND get flushed to answer.md
 *   - message_done with non-empty finalText overwrites authoritatively +
 *     appends ## DONE sentinel when missing
 *   - message_done with EMPTY finalText keeps accumulated deltas
 *     (the Gemini "result-line-only" failure mode)
 *   - error event flips errored AND preserves accumulated content
 *   - StreamFileWriter buffer is flushed in the finally block on every path
 */
import * as fs from 'fs';
import type { StandardPhase } from '../../lib/template-schema.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../lib/template-schema.js';
import type { AgentShim } from '../agents/types.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import { StreamFileWriter } from './stream-file-writer.js';
import type { RunnerEvent } from './types.js';

export async function runDoerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: StandardPhase;
  round: number;
  agentName: string;
  askContent: string;
  answerFile: string;
  /** Doer's working dir — repoPath when chat targets a real repo, else scratch. */
  doerCwd: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
}): Promise<{
  content: string;
  full: boolean;
  /**
   * Token-usage block from the message_done terminal event. Undefined
   * when the upstream shim doesn't (yet) populate it — kimi/opencode
   * fall through with no usage; claude/codex/gemini will once their
   * parsers are migrated. The runner persists these into phase_events
   * tokens_in/tokens_out + cost_usd in a follow-up wiring PR.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
} | null> {
  const {
    shim,
    chatId,
    phase,
    round,
    agentName,
    askContent,
    answerFile,
    doerCwd,
    abortSignal,
    onEvent,
  } = args;

  if (!shim.runHeadless) {
    // Defensive — caller should have checked. Fail closed.
    return null;
  }

  const perms = await getPermissions();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;
  let capturedUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  } | undefined;

  // Initialize answer.md so the artifacts endpoint sees the file mid-stream.
  fs.writeFileSync(answerFile, '');
  const writer = new StreamFileWriter(answerFile);

  const stream = shim.runHeadless({
    cwd: doerCwd,
    promptText: askContent,
    model: phase.doer.models?.[0],
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
            role: 'doer',
            agent: agentName,
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
            role: 'doer',
            agent: agentName,
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
            role: 'doer',
            agent: agentName,
            elapsedMs: event.elapsedMs,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'message_done') {
        finalText = event.finalText;
        if (event.usage) capturedUsage = event.usage;
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
          const needsSentinel = !/\n##\s*DONE\s*\n?$/i.test(
            event.finalText.trimEnd(),
          );
          const finalContent = needsSentinel
            ? `${event.finalText}\n\n## DONE\n`
            : event.finalText.endsWith('\n')
              ? event.finalText
              : `${event.finalText}\n`;
          fs.writeFileSync(answerFile, finalContent);
        }
      } else if (event.type === 'error') {
        errored = true;
        onEvent({
          chatId,
          type: 'cli_error',
          payload: {
            phaseId: phase.id,
            round,
            role: 'doer',
            agent: agentName,
            error: {
              kind: event.kind,
              message: event.message,
              lineage: phase.doer.lineage,
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
        role: 'doer',
        agent: agentName,
        error: {
          kind: 'stream_failure',
          message: err instanceof Error ? err.message : String(err),
          lineage: phase.doer.lineage,
        },
      },
      ts: Date.now(),
    });
  } finally {
    writer.flushNow();
    // If the StreamFileWriter went dead (FS ENOSPC, EACCES, etc.) it
    // dropped the failing chunk to avoid retrying the same sync write
    // forever. Surface this so the user sees "stream stopped writing"
    // rather than silently truncated answer.md.
    if (writer.isDead()) {
      const err = writer.lastError();
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'doer',
          agent: agentName,
          reason: 'stream_writer_dead',
          message: `answer.md write failed; subsequent deltas dropped: ${err ? err.message : 'unknown'}`,
          cta: 'Check disk space + permissions on ~/.chorus/chats. Re-run when fixed.',
        },
        ts: Date.now(),
      });
    }
  }

  if (errored && finalText === undefined && accumulated.length === 0) {
    return null;
  }

  const content = finalText && finalText.length > 0 ? finalText : accumulated;

  if (finalText === undefined && content.trim().length === 0) {
    return null;
  }

  return {
    content,
    full: finalText !== undefined || accumulated.length > 0,
    ...(capturedUsage ? { usage: capturedUsage } : {}),
  };
}
