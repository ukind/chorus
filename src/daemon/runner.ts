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

// TODO(H): replace stubs after F+G merge with real imports
import type { TmuxManager } from './tmux-types.js';
import type { AgentRegistry } from './agents/types.js';

// Stubs for type checking until Agent F (tmux) and Agent G (shims) are merged
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const tmuxMgr = {} as TmuxManager;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const registry = {} as AgentRegistry;

export interface RunnerEvent {
  chatId: string;
  type:
    | 'phase_start'
    | 'phase_progress'
    | 'phase_done'
    | 'phase_failed'
    | 'cli_error'
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
  const { chatId, template, work, onEvent, abortSignal } = opts;
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
          work
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
            work
          );

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
      payload: { status: 'completed' },
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

async function runDoer(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string
): Promise<{ content: string; full: boolean } | null> {
  const roundDir = path.join(chatDir, `round-${round}`);
  const doerDir = path.join(roundDir, `doer-${phase.doer.lineage}`);

  if (!fs.existsSync(doerDir)) {
    fs.mkdirSync(doerDir, { recursive: true });
  }

  const askFile = path.join(doerDir, 'ask.md');
  const answerFile = path.join(doerDir, 'answer.md');

  // Write ask.md
  const ask = buildAsk(phase, phaseIdx, round, work, phase.inputs);
  fs.writeFileSync(askFile, ask);

  // Acquire session
  // TODO(H): implement once TmuxManager arrives
  // const session = await tmuxMgr.acquire({
  //   chatId,
  //   phaseId: phase.id,
  //   role: 'doer',
  //   round,
  //   shareSessionAcrossRounds: phase.iterate.shareSessionAcrossRounds,
  //   shareSessionAcrossPhases: phase.iterate.shareSessionAcrossPhases,
  //   spawn: {
  //     sessionName: `chorus-${chatId}-${phase.id}-doer-${round}`,
  //     cwd: doerDir,
  //     lineage: phase.doer.lineage,
  //     model: phase.doer.models?.[0],
  //   },
  // });

  // const shim = registry.pickShim(phase.doer.lineage);
  // shim.preNudge?.(session.name);

  // const prompt = shim.formatPrompt({
  //   promptFile: askFile,
  //   answerFile,
  //   task: phase.title,
  //   expectDoneSentinel: true,
  // });

  // tmuxMgr.pasteBuffer(session.name, prompt);
  // tmuxMgr.sendKeys(session.name, ['Enter']);

  // For now, stub: wait for answer file to appear
  // In real flow, CLI writes to answer.md
  try {
    const result = await waitForAnswer(answerFile, {
      timeoutMs: 5 * 60 * 1000, // 5 min
      doneSentinel: '## DONE',
    });
    return result;
  } catch {
    return null;
  }
}

async function runReviewers(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  doerOutput: string,
  work: string
): Promise<{ agreed: boolean; summary: string }> {
  if (!phase.reviewer || phase.reviewer.candidates.length === 0) {
    return { agreed: true, summary: '' };
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true });
  }

  const reviews: { reviewer: string; verdict: boolean }[] = [];

  // Fan out reviewers in parallel (can be changed to sequential if needed)
  const reviewPromises = phase.reviewer.candidates.map((candidate, idx) =>
    runReviewer(
      chatDir,
      chatId,
      phase,
      phaseIdx,
      round,
      idx,
      doerOutput,
      work
    ).then((verdict) => {
      reviews.push({
        reviewer: `${candidate.lineage}-${idx}`,
        verdict,
      });
    })
    .catch(() => {
      // Reviewer failure: count as disagreement
      reviews.push({
        reviewer: `${candidate.lineage}-${idx}`,
        verdict: false,
      });
    })
  );

  await Promise.all(reviewPromises);

  // Check consensus
  const agreedCount = reviews.filter((r) => r.verdict).length;
  const required = phase.reviewer.require;
  const agreed = agreedCount >= required;

  const summary =
    reviews.length > 0
      ? `${agreedCount}/${reviews.length} reviewers agreed`
      : 'No reviews completed';

  return { agreed, summary };
}

async function runReviewer(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  reviewerIdx: number,
  doerOutput: string,
  work: string
): Promise<boolean> {
  if (!phase.reviewer) return true;
  const candidate = phase.reviewer.candidates[reviewerIdx];

  const roundDir = path.join(chatDir, `round-${round}`);
  const reviewerDir = path.join(roundDir, `reviewer-${candidate.lineage}-${reviewerIdx}`);

  if (!fs.existsSync(reviewerDir)) {
    fs.mkdirSync(reviewerDir, { recursive: true });
  }

  const askFile = path.join(reviewerDir, 'ask.md');
  const answerFile = path.join(reviewerDir, 'answer.md');

  // Write ask.md for reviewer
  const ask = buildReviewerAsk(phase, phaseIdx, round, work, doerOutput);
  fs.writeFileSync(askFile, ask);

  // Spawn reviewer
  // TODO(H): implement once TmuxManager + registry arrive
  // const session = await tmuxMgr.acquire({
  //   chatId,
  //   phaseId: phase.id,
  //   role: 'reviewer',
  //   round,
  //   shareSessionAcrossRounds: false,
  //   shareSessionAcrossPhases: false,
  //   spawn: {
  //     sessionName: `chorus-${chatId}-${phase.id}-reviewer-${reviewerIdx}`,
  //     cwd: reviewerDir,
  //     lineage: candidate.lineage,
  //     model: candidate.models?.[0],
  //   },
  // });

  // const shim = registry.pickShim(candidate.lineage);
  // const prompt = shim.formatPrompt({
  //   promptFile: askFile,
  //   answerFile,
  //   task: `Review: ${phase.title}`,
  //   expectDoneSentinel: true,
  // });
  // tmuxMgr.pasteBuffer(session.name, prompt);
  // tmuxMgr.sendKeys(session.name, ['Enter']);

  try {
    const result = await waitForAnswer(answerFile, {
      timeoutMs: 5 * 60 * 1000,
      doneSentinel: '## DONE',
    });

    // Parse verdict from answer (stub: check for "approve" keyword)
    const approved =
      result.content.toLowerCase().includes('approve') ||
      result.content.toLowerCase().includes('good');
    return approved;
  } catch {
    return false;
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
