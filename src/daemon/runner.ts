/**
 * Phase runner — orchestrates template execution.
 * Spawns CLI sessions per phase/round/role, writes prompts, watches for answers,
 * handles reviewer consensus, and emits SSE events to the client.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Template, Phase } from '../lib/template-schema.js';
import { waitForAnswer } from './output-watcher.js';

import type { TmuxManager } from './tmux-types.js';
import { registry } from './agents/index.js';
import { ErrorDetector } from './error-detector.js';
import { getPermissions } from '../lib/settings/permissions.js';
import { getTransport } from '../lib/settings/transport.js';
import { recordHealth, kindToStatus, type CliLineage } from '../lib/cli-health.js';
import type { AgentShim } from './agents/types.js';

export interface RunnerEvent {
  chatId: string;
  type:
    | 'phase_start'
    | 'phase_progress'
    | 'phase_done'
    | 'phase_failed'
    | 'cli_error'
    | 'cli_warning'
    | 'chat_done';
  payload: Record<string, unknown>;
  ts: number;
}

export interface PhaseRunnerOptions {
  chatId: string;
  template: Template;
  work: string;
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
}

interface ChatMeta {
  chatId: string;
  work: string;
  templateId: string;
  createdAt: number;
}

/**
 * Main runner. Iterates phases, spawns doers, waits for answers, runs reviewers,
 * checks consensus, and emits events.
 */
export async function runChat(opts: PhaseRunnerOptions): Promise<void> {
  const { chatId, template, work, onEvent, abortSignal, tmuxMgr, errorDetector } = opts;
  const chatDir = path.join(os.homedir(), '.chorus', 'chats', chatId);

  // Ensure chat directory
  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }

  // Write meta
  const meta: ChatMeta = {
    chatId,
    work,
    templateId: template.id,
    createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify(meta, null, 2));

  // Abort handler
  const abortListener = () => {
    // TODO(H): send polite Escape to active session, flip status to cancelled
    onEvent({
      chatId,
      type: 'chat_done',
      payload: { status: 'cancelled' },
      ts: Date.now(),
    });
  };
  abortSignal.addEventListener('abort', abortListener);

  // Track whether any phase failed because every reviewer in it failed
  // (timeout/quota/crash). If so, the chat ends in 'no_review' rather than
  // 'approved' — there was no actual peer review to approve from.
  let anyPhaseAllReviewersFailed = false;

  try {
    // Walk phases
    for (let phaseIdx = 0; phaseIdx < template.phases.length; phaseIdx++) {
      if (abortSignal.aborted) break;

      const phase = template.phases[phaseIdx];

      // Run doer loop with retries
      let doerSucceeded = false;
      for (
        let round = 1;
        round <= phase.iterate.maxRounds;
        round++
      ) {
        if (abortSignal.aborted) break;

        onEvent({
          chatId,
          type: 'phase_start',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            kind: phase.kind,
            round,
            role: 'doer',
            agent: phase.doer.lineage,
          },
          ts: Date.now(),
        });

        // Spawn doer
        const doerAnswer = await runDoer(
          chatDir,
          chatId,
          phase,
          phaseIdx,
          round,
          work,
          tmuxMgr,
          errorDetector,
          onEvent,
          abortSignal,
        );

        if (!doerAnswer) {
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: {
              phaseId: phase.id,
              reason: 'doer_timeout',
            },
            ts: Date.now(),
          });
          break;
        }

        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'doer',
            output: doerAnswer.content.slice(0, 500),
          },
          ts: Date.now(),
        });

        // Run reviewers if present
        if (phase.reviewer && phase.reviewer.candidates.length > 0) {
          const consensus = await runReviewers(
            chatDir,
            chatId,
            phase,
            phaseIdx,
            round,
            doerAnswer.content,
            work,
            tmuxMgr,
            errorDetector,
            onEvent,
            abortSignal,
          );

          if (consensus.allFailed) {
            anyPhaseAllReviewersFailed = true;
          }

          if (consensus.agreed) {
            doerSucceeded = true;
            break;
          }

          // Disagreement: feed back for next round if more rounds available
          if (round < phase.iterate.maxRounds) {
            onEvent({
              chatId,
              type: 'phase_progress',
              payload: {
                phaseId: phase.id,
                round,
                role: 'reviewer',
                disagreement: consensus.summary,
              },
              ts: Date.now(),
            });
          }
        } else {
          // No reviewers: doer succeeds immediately
          doerSucceeded = true;
          break;
        }
      }

      if (!doerSucceeded) {
        onEvent({
          chatId,
          type: 'phase_failed',
          payload: {
            phaseId: phase.id,
            reason: 'max_rounds_exhausted',
          },
          ts: Date.now(),
        });
        // Continue to next phase or fail entire chat?
        // For now, continue (escalation policy per phase.iterate.onDisagreement)
      }

      onEvent({
        chatId,
        type: 'phase_done',
        payload: {
          phaseId: phase.id,
          phaseIdx,
          kind: phase.kind,
        },
        ts: Date.now(),
      });
    }

    onEvent({
      chatId,
      type: 'chat_done',
      payload: {
        status: anyPhaseAllReviewersFailed ? 'no_review' : 'completed',
        verdict: anyPhaseAllReviewersFailed ? 'no_review' : 'approved',
      },
      ts: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent({
      chatId,
      type: 'chat_done',
      payload: { status: 'failed', error: message },
      ts: Date.now(),
    });
  } finally {
    abortSignal.removeEventListener('abort', abortListener);
  }
}

/**
 * Headless transport doer: spawn the CLI in --print mode, consume the
 * AgentEvent stream, persist incrementally to answer.md so the existing
 * artifacts API + run page (which polls answer.md every 4s) sees live
 * progress without UI changes.
 *
 * Returns the same shape as runDoer for drop-in consumption by the phase loop.
 */
async function runDoerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: Phase;
  round: number;
  agentName: string;
  askContent: string;
  answerFile: string;
  doerDir: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
}): Promise<{ content: string; full: boolean } | null> {
  const { shim, chatId, phase, round, agentName, askContent, answerFile, doerDir, abortSignal, onEvent } =
    args;

  if (!shim.runHeadless) {
    // Defensive — caller should have checked. Fail closed.
    return null;
  }

  const perms = getPermissions();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;

  // Initialize answer.md so the artifacts endpoint sees the file mid-stream.
  fs.writeFileSync(answerFile, '');

  const stream = shim.runHeadless({
    cwd: doerDir,
    promptText: askContent,
    model: phase.doer.models?.[0],
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
        // Append-write so the file grows monotonically — run page polling
        // sees progress without races. Sync write is fine; deltas are small.
        fs.appendFileSync(answerFile, event.text);
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
        // Heartbeat from non-streaming CLIs — surface so UI knows we're alive.
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
        // Authoritative final write. Only append the ## DONE sentinel if the
        // model didn't already write one (some models include it in their
        // response when the prompt asks for it — duplicate sentinels look
        // sloppy in the artifact viewer).
        const needsSentinel = !/\n##\s*DONE\s*\n?$/i.test(event.finalText.trimEnd());
        const finalContent = needsSentinel
          ? `${event.finalText}\n\n## DONE\n`
          : event.finalText.endsWith('\n')
            ? event.finalText
            : `${event.finalText}\n`;
        fs.writeFileSync(answerFile, finalContent);
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
            error: { kind: event.kind, message: event.message, lineage: phase.doer.lineage },
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
  }

  if (errored && finalText === undefined && accumulated.length === 0) {
    return null;
  }

  // Prefer the authoritative finalText from message_done when non-empty
  // (Claude carries the full result there). Fall back to accumulated
  // deltas when message_done was empty (Gemini's result line is stats-only)
  // or absent (CLI exited unexpectedly).
  const content = finalText && finalText.length > 0 ? finalText : accumulated;
  return { content, full: finalText !== undefined || accumulated.length > 0 };
}

async function runDoer(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
): Promise<{ content: string; full: boolean } | null> {
  const shim = registry.pickShim(phase.doer.lineage);
  const agentName = shim.name;
  const roundDir = path.join(chatDir, `round-${round}`);
  const doerDir = path.join(roundDir, `doer-${agentName}`);

  if (!fs.existsSync(doerDir)) {
    fs.mkdirSync(doerDir, { recursive: true });
  }

  const askFile = path.join(doerDir, 'ask.md');
  const answerFile = path.join(doerDir, 'answer.md');

  // Write ask.md (the prompt body the CLI reads).
  const ask = buildAsk(phase, phaseIdx, round, work, phase.inputs);
  fs.writeFileSync(askFile, ask);

  // Transport branch: headless when settings + shim support it; otherwise
  // fall through to the tmux flow below. Mixed-mode in a single chat is OK
  // — Claude can run headless while Gemini reviewer falls back to tmux.
  const transport = getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    return runDoerHeadless({
      shim,
      chatId,
      phase,
      round,
      agentName,
      askContent: ask,
      answerFile,
      doerDir,
      abortSignal,
      onEvent,
    });
  }

  // Acquire session — fresh per chat by default; reuses across rounds when
  // template policy says so (shareSessionAcrossRounds, default true).
  const perms = getPermissions();
  const sessionName = sanitizeName(`chorus-${chatId}-${phase.id}-doer-${agentName}`);
  const session = await tmuxMgr.acquire({
    chatId,
    phaseId: phase.id,
    role: 'doer',
    round,
    shareSessionAcrossRounds: phase.iterate.shareSessionAcrossRounds,
    shareSessionAcrossPhases: phase.iterate.shareSessionAcrossPhases,
    shim,
    spawnOpts: {
      sessionName,
      cwd: doerDir,
      model: phase.doer.models?.[0],
      sandbox: perms.sandboxProfile,
      autoApprove: perms.autoApprovePrompts,
      networkAccess: perms.networkAccess,
    },
    agentName,
  });

  // Per-CLI pre-nudge cleanup (e.g. /clear opencode, dismiss overlays).
  if (shim.clearKeys && shim.clearKeys.length > 0) {
    tmuxMgr.sendKeys(session.name, [...shim.clearKeys]);
  }
  if (shim.preNudge) shim.preNudge(session.name);

  const prompt = shim.formatPrompt({
    promptFile: askFile,
    answerFile,
    task: phase.title,
    expectDoneSentinel: true,
  });

  // Wait for the CLI's TUI to finish cold-start before pasting. 6s covers
  // Codex's slow cold-start (it auths + paints panels); shorter and the
  // Enter we send below races against the input box being ready and gets
  // eaten. Raise if a slower box still misses the prompt.
  await new Promise((r) => setTimeout(r, 6000));

  tmuxMgr.pasteBuffer(session.name, prompt);
  // Small gap between paste and Enter so the TUI registers the paste before
  // we submit.
  await new Promise((r) => setTimeout(r, 500));
  tmuxMgr.sendKeys(session.name, ['Enter']);

  // Poll capture-pane every 2s to surface known CLI failure modes while we
  // wait for the answer file. The detector is stateful for opencode's
  // sustained-error pattern.
  const pollHandle = setInterval(() => {
    try {
      const pane = tmuxMgr.capturePane(session.name);
      const err = errorDetector.inspect(session.name, phase.doer.lineage, pane);
      if (err) {
        const recoveryKeys =
          err.kind === 'permission_prompt' ? shim.recoverKeys?.permission_prompt : undefined;
        if (recoveryKeys && recoveryKeys.length > 0) {
          // Layer 2 recovery: navigate the dialog, emit a warning (not error),
          // skip health recording — we recovered, no degradation.
          tmuxMgr.sendKeys(session.name, [...recoveryKeys]);
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'doer',
              agent: agentName,
              recovered: err.kind,
              keys: [...recoveryKeys],
              detail: err.detail,
            },
            ts: Date.now(),
          });
        } else {
          recordHealth({
            lineage: phase.doer.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          });
          onEvent({
            chatId,
            type: 'cli_error',
            payload: { phaseId: phase.id, round, role: 'doer', agent: agentName, error: err },
            ts: Date.now(),
          });
        }
      }
    } catch {
      // ignore — the watcher will time out independently
    }
  }, 2000);

  try {
    return await waitForAnswer(answerFile, {
      timeoutMs: 5 * 60 * 1000,
      doneSentinel: '## DONE',
    });
  } catch {
    return null;
  } finally {
    clearInterval(pollHandle);
  }
}

function sanitizeName(name: string): string {
  // tmux session names accept [a-zA-Z0-9_-]; drop everything else and clamp length.
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
}

async function runReviewers(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  doerOutput: string,
  work: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
): Promise<{ agreed: boolean; summary: string; allFailed: boolean }> {
  if (!phase.reviewer || phase.reviewer.candidates.length === 0) {
    return { agreed: true, summary: '', allFailed: false };
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true });
  }

  // Each reviewer returns: 'agreed' | 'disagreed' | 'failed'.
  // 'failed' = reviewer never produced a valid answer (timeout, quota, crash).
  // The chat-level verdict has to know the difference: if EVERY reviewer
  // failed, we shouldn't auto-approve — there was no actual peer review.
  const reviews: {
    reviewer: string;
    outcome: 'agreed' | 'disagreed' | 'failed';
  }[] = [];

  const reviewPromises = phase.reviewer.candidates.map((candidate, idx) =>
    runReviewer(
      chatDir,
      chatId,
      phase,
      phaseIdx,
      round,
      idx,
      doerOutput,
      work,
      tmuxMgr,
      errorDetector,
      onEvent,
      abortSignal,
    )
      .then((res) => {
        reviews.push({
          reviewer: `${candidate.lineage}-${idx}`,
          outcome: res === null ? 'failed' : res ? 'agreed' : 'disagreed',
        });
      })
      .catch(() => {
        reviews.push({
          reviewer: `${candidate.lineage}-${idx}`,
          outcome: 'failed',
        });
      }),
  );

  await Promise.all(reviewPromises);

  const agreedCount = reviews.filter((r) => r.outcome === 'agreed').length;
  const failedCount = reviews.filter((r) => r.outcome === 'failed').length;
  const required = phase.reviewer.require;
  const agreed = agreedCount >= required;
  const allFailed = failedCount === reviews.length && reviews.length > 0;

  const summary = allFailed
    ? `All ${reviews.length} reviewer(s) failed (timeout/quota/crash)`
    : reviews.length > 0
      ? `${agreedCount}/${reviews.length} reviewers agreed${failedCount ? `, ${failedCount} failed` : ''}`
      : 'No reviews completed';

  return { agreed, summary, allFailed };
}

/**
 * Headless transport reviewer. Mirrors runDoerHeadless but returns the
 * boolean | null verdict shape that runReviewers expects:
 *   true  = reviewer approved (answer text contains "approve" / "good")
 *   false = reviewer disagreed
 *   null  = reviewer never produced a valid answer
 */
async function runReviewerHeadless(args: {
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

  const perms = getPermissions();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;

  fs.writeFileSync(answerFile, '');

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
        fs.appendFileSync(answerFile, event.text);
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
        fs.writeFileSync(answerFile, `${event.finalText}\n\n## DONE\n`);
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
            error: { kind: event.kind, message: event.message, lineage: candidateLineage },
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
  }

  const content = finalText && finalText.length > 0 ? finalText : accumulated;
  if (errored && content.trim().length === 0) return null;
  if (content.trim().length === 0) return null;

  // Same verdict heuristic as the tmux reviewer path.
  const lower = content.toLowerCase();
  return lower.includes('approve') || lower.includes('good');
}

async function runReviewer(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  reviewerIdx: number,
  doerOutput: string,
  work: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
): Promise<boolean | null> {
  // Returns:
  //   true  = reviewer ran and approved
  //   false = reviewer ran and disagreed
  //   null  = reviewer never produced a valid answer (timeout/quota/crash)
  if (!phase.reviewer) return true;
  const candidate = phase.reviewer.candidates[reviewerIdx];

  const shim = registry.pickShim(candidate.lineage);
  const agentName = shim.name;

  const roundDir = path.join(chatDir, `round-${round}`);
  const reviewerDir = path.join(roundDir, `reviewer-${agentName}-${reviewerIdx}`);

  if (!fs.existsSync(reviewerDir)) {
    fs.mkdirSync(reviewerDir, { recursive: true });
  }

  const askFile = path.join(reviewerDir, 'ask.md');
  const answerFile = path.join(reviewerDir, 'answer.md');

  const ask = buildReviewerAsk(phase, phaseIdx, round, work, doerOutput);
  fs.writeFileSync(askFile, ask);

  // Headless branch — same pattern as runDoer. Mixed-mode is fine: doer can
  // run headless while a reviewer of a different lineage falls back to tmux.
  const transport = getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    return runReviewerHeadless({
      shim,
      chatId,
      phase,
      round,
      reviewerIdx,
      candidateLineage: candidate.lineage,
      candidateModel: candidate.models?.[0],
      agentName,
      askContent: ask,
      answerFile,
      reviewerDir,
      abortSignal,
      onEvent,
    });
  }

  // Reviewers don't share sessions across rounds — each round wants a fresh
  // perspective on the new doer output. Across-phase reuse never makes sense.
  const perms = getPermissions();
  const sessionName = sanitizeName(
    `chorus-${chatId}-${phase.id}-reviewer-${agentName}-${reviewerIdx}`,
  );
  const session = await tmuxMgr.acquire({
    chatId,
    phaseId: phase.id,
    role: 'reviewer',
    round,
    shareSessionAcrossRounds: false,
    shareSessionAcrossPhases: false,
    shim,
    spawnOpts: {
      sessionName,
      cwd: reviewerDir,
      model: candidate.models?.[0],
      sandbox: perms.sandboxProfile,
      autoApprove: perms.autoApprovePrompts,
      networkAccess: perms.networkAccess,
    },
    agentName: `${agentName}-${reviewerIdx}`,
  });

  if (shim.clearKeys && shim.clearKeys.length > 0) {
    tmuxMgr.sendKeys(session.name, [...shim.clearKeys]);
  }
  if (shim.preNudge) shim.preNudge(session.name);

  const prompt = shim.formatPrompt({
    promptFile: askFile,
    answerFile,
    task: `Review: ${phase.title}`,
    expectDoneSentinel: true,
  });
  // Wait for the CLI's TUI to finish cold-start before pasting. 6s covers
  // Codex's slow cold-start (it auths + paints panels); shorter and the
  // Enter we send below races against the input box being ready and gets
  // eaten. Raise if a slower box still misses the prompt.
  await new Promise((r) => setTimeout(r, 6000));

  tmuxMgr.pasteBuffer(session.name, prompt);
  // Small gap between paste and Enter so the TUI registers the paste before
  // we submit.
  await new Promise((r) => setTimeout(r, 500));
  tmuxMgr.sendKeys(session.name, ['Enter']);

  // Failure-mode polling — same pattern as the doer.
  const pollHandle = setInterval(() => {
    try {
      const pane = tmuxMgr.capturePane(session.name);
      const err = errorDetector.inspect(session.name, candidate.lineage, pane);
      if (err) {
        const recoveryKeys =
          err.kind === 'permission_prompt' ? shim.recoverKeys?.permission_prompt : undefined;
        if (recoveryKeys && recoveryKeys.length > 0) {
          // Layer 2 recovery — see doer poll loop above for rationale.
          tmuxMgr.sendKeys(session.name, [...recoveryKeys]);
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
              recovered: err.kind,
              keys: [...recoveryKeys],
              detail: err.detail,
            },
            ts: Date.now(),
          });
        } else {
          recordHealth({
            lineage: candidate.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          });
          onEvent({
            chatId,
            type: 'cli_error',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
              error: err,
            },
            ts: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }
  }, 2000);

  try {
    const result = await waitForAnswer(answerFile, {
      timeoutMs: 5 * 60 * 1000,
      doneSentinel: '## DONE',
    });
    if (!result.full || result.content.trim().length === 0) {
      // Watcher resolved on timeout/silence with no real answer.
      return null;
    }
    const approved =
      result.content.toLowerCase().includes('approve') ||
      result.content.toLowerCase().includes('good');
    return approved;
  } catch {
    // Timed out or watcher errored — no valid answer produced.
    return null;
  } finally {
    clearInterval(pollHandle);
  }
}

function buildAsk(
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  inputs: Phase['inputs']
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
  lines.push('## The user\'s request');
  lines.push(work);
  lines.push('');

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

function buildReviewerAsk(
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  doerOutput: string
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
  lines.push('## The user\'s request');
  lines.push(work);
  lines.push('');
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
    'Do you approve? Answer: approve or request changes, end with: ## DONE'
  );

  return lines.join('\n');
}
