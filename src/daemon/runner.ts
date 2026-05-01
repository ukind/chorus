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
import { detectGitContext, runShipPhase } from './ship.js';

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
  /**
   * Optional absolute path to the user's repo. When set:
   *  - Doer cwd becomes this path (real edits land in the working tree)
   *  - Reviewers stay in scratch dirs (read-only, no writes to user's repo)
   *  - Ship phase (if template.ship.enabled) runs after consensus
   * When unset: doer cwd is scratch dir as before; ship phase auto-skips.
   */
  repoPath?: string;
  /**
   * Optional list of file paths to read and inline into doer + reviewer
   * prompts. Paths are resolved relative to repoPath when set, else absolute.
   * Missing files are skipped with a note. Each file is capped at 64 KB,
   * total payload at 256 KB; oversize is truncated with a marker. Previously
   * `attached_files` was stored on the chat row but never read — this is the
   * wire-up so `invoke_persona({files: [...]})` actually reaches the prompt.
   */
  attachedFiles?: string[];
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
  const { chatId, template, work, repoPath, attachedFiles, onEvent, abortSignal, tmuxMgr, errorDetector } = opts;
  const chatDir = path.join(os.homedir(), '.chorus', 'chats', chatId);

  // Pack attached files into a single block once per chat. Both doer + every
  // reviewer get the same block — they're auditing the same artifacts.
  const filesBlock = packAttachedFiles(attachedFiles, repoPath);

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

  // chat_done is a one-way latch. The abort listener and the normal terminal
  // emission (line 304+) both try to fire it; whichever runs first wins. This
  // closes a race where SSE-disconnect → abort → chat_done(cancelled), then
  // the loop kept running and emitted chat_done(completed), overwriting
  // 'cancelled' with 'approved' in the DB. Now: first emission sticks.
  let chatDoneEmitted = false;
  const emitChatDone = (payload: Record<string, unknown>): void => {
    if (chatDoneEmitted) return;
    chatDoneEmitted = true;
    onEvent({ chatId, type: 'chat_done', payload, ts: Date.now() });
  };

  // Abort handler
  const abortListener = () => {
    // TODO(H): send polite Escape to active session, flip status to cancelled
    emitChatDone({ status: 'cancelled' });
  };
  abortSignal.addEventListener('abort', abortListener);

  // Track whether any phase failed because every reviewer in it failed
  // (timeout/quota/crash). If so, the chat ends in 'no_review' rather than
  // 'approved' — there was no actual peer review to approve from.
  let anyPhaseAllReviewersFailed = false;
  // Track whether any doer failed all rounds (couldn't produce output). If so,
  // the chat must NOT end approved — there was no real implementation to review.
  let anyPhaseDoerFailed = false;

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
          filesBlock,
          tmuxMgr,
          errorDetector,
          onEvent,
          abortSignal,
          repoPath,
        );

        if (!doerAnswer) {
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: {
              phaseId: phase.id,
              phaseIdx,
              kind: phase.kind,
              role: 'doer',
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
            filesBlock,
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
        anyPhaseDoerFailed = true;
        onEvent({
          chatId,
          type: 'phase_failed',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            kind: phase.kind,
            role: 'doer',
            reason: 'max_rounds_exhausted',
          },
          ts: Date.now(),
        });
        // Don't continue to subsequent phases when a doer failed every round —
        // there is no real implementation to feed forward, and the chat must
        // not end 'approved'. The chat_done branch below handles the terminal
        // status as 'failed' / 'no_review' instead of completed.
        break;
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

    // ─── Ship phase ───────────────────────────────────────────────────
    // Runs after all phases pass + reviewers agree, AND chat targets a real
    // repo, AND template opted in. Failures are surfaced as status=blocked
    // (chat ran fine, ship couldn't complete) rather than failed (chat broke).
    let shipOutcome:
      | { kind: 'skipped'; reason?: string }
      | { kind: 'merged'; prUrl: string }
      | { kind: 'blocked'; error: string }
      = { kind: 'skipped' };

    if (!anyPhaseAllReviewersFailed && template.ship?.enabled && repoPath) {
      const ctx = detectGitContext(repoPath, template.ship.baseBranch);
      if (!ctx.ok) {
        // Surface as a skip with reason — chat still ends approved (we
        // didn't ship, but the review was real).
        shipOutcome = { kind: 'skipped', reason: `${ctx.reason}: ${ctx.detail}` };
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: { phaseId: 'ship', skipped: true, reason: ctx.reason, detail: ctx.detail },
          ts: Date.now(),
        });
      } else {
        // Read the most recent doer's output for the PR body. Fall back to
        // the chat's `work` if we can't find it (shouldn't happen in
        // practice — ship phase only runs after a successful doer).
        const lastDoerOutput = readLastDoerAnswer(chatDir) ?? work;
        onEvent({
          chatId,
          type: 'phase_start',
          payload: { phaseId: 'ship', kind: 'ship' },
          ts: Date.now(),
        });
        const result = runShipPhase({
          context: ctx.context,
          chatId,
          templateId: template.id,
          branchPattern: template.ship.branchPattern ?? 'chorus/{chatId}',
          titleTemplate: template.ship.titleTemplate ?? 'chorus: {template} via #{chatId}',
          summary: work,
          doerOutput: lastDoerOutput,
        });
        if (result.ok) {
          shipOutcome = { kind: 'merged', prUrl: result.prUrl };
          onEvent({
            chatId,
            type: 'phase_done',
            payload: { phaseId: 'ship', prUrl: result.prUrl, branch: result.branch },
            ts: Date.now(),
          });
        } else {
          shipOutcome = { kind: 'blocked', error: `${result.stage}: ${result.detail}` };
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: { phaseId: 'ship', stage: result.stage, detail: result.detail },
            ts: Date.now(),
          });
        }
      }
    }

    // Final chat_done — encodes terminal status and ship-phase outcome.
    // Routed through emitChatDone so an earlier abort (SSE close, user cancel)
    // can't be overwritten by a later "completed" emission.
    if (anyPhaseDoerFailed) {
      // The doer never produced a real implementation. Don't pretend the
      // chat was reviewed — surface as failed so the cockpit shows it red.
      emitChatDone({ status: 'failed', verdict: 'failed', error: 'doer_failed_all_rounds' });
    } else if (anyPhaseAllReviewersFailed) {
      emitChatDone({ status: 'no_review', verdict: 'no_review' });
    } else if (shipOutcome.kind === 'merged') {
      emitChatDone({
        status: 'merged',
        verdict: 'approved',
        prUrl: shipOutcome.prUrl,
      });
    } else if (shipOutcome.kind === 'blocked') {
      emitChatDone({ status: 'blocked', verdict: 'approved', shipError: shipOutcome.error });
    } else {
      // Either no ship phase or ship was skipped — chat ends approved.
      emitChatDone({
        status: 'completed',
        verdict: 'approved',
        ...(shipOutcome.kind === 'skipped' && shipOutcome.reason
          ? { shipSkipped: shipOutcome.reason }
          : {}),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitChatDone({ status: 'failed', error: message });
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
  /** Doer's working dir — repoPath when chat targets a real repo, else scratch. */
  doerCwd: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
}): Promise<{ content: string; full: boolean } | null> {
  const { shim, chatId, phase, round, agentName, askContent, answerFile, doerCwd, abortSignal, onEvent } =
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
    cwd: doerCwd,
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

  // Treat "stream ended with no content AND no message_done" as a failure even
  // when the parser didn't emit an explicit error event. This catches CLI
  // exits where stdout was unparseable, the process was killed early by an
  // abort, or the SDK ended the stream silently — all of which previously
  // returned `{content: '', full: false}` which the phase loop happily
  // accepted as a successful empty doer answer.
  if (finalText === undefined && content.trim().length === 0) {
    return null;
  }

  return { content, full: finalText !== undefined || accumulated.length > 0 };
}

async function runDoer(
  chatDir: string,
  chatId: string,
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  filesBlock: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
  repoPath?: string,
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
  const ask = buildAsk(phase, phaseIdx, round, work, phase.inputs, filesBlock);
  fs.writeFileSync(askFile, ask);

  // When the chat was created with a repoPath, the doer's working tree
  // becomes the user's repo (so it can read files + make real edits the
  // ship phase will commit). Reviewers always stay in scratch — they're
  // not allowed to write to the user's repo. ask.md/answer.md still live
  // in the chat dir for artifact viewing.
  const doerCwd = repoPath ?? doerDir;

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
      doerCwd,
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
      cwd: doerCwd,
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

/**
 * Find and read the most recent doer's answer.md from the chat dir. Used by
 * the ship phase to embed doer output in the PR body. Returns undefined
 * if no doer output exists (shouldn't happen since ship runs after success).
 */
function readLastDoerAnswer(chatDir: string): string | undefined {
  if (!fs.existsSync(chatDir)) return undefined;
  // Walk rounds in reverse (highest first). Within each round pick the
  // doer-* dir's answer.md. There's at most one doer per round.
  const rounds = fs
    .readdirSync(chatDir)
    .filter((n) => /^round-\d+$/.test(n))
    .map((n) => ({ name: n, num: parseInt(n.replace('round-', ''), 10) }))
    .sort((a, b) => b.num - a.num);

  for (const r of rounds) {
    const roundDir = path.join(chatDir, r.name);
    const doerSubdir = fs
      .readdirSync(roundDir)
      .find((n) => n.startsWith('doer-'));
    if (!doerSubdir) continue;
    const answerFile = path.join(roundDir, doerSubdir, 'answer.md');
    if (fs.existsSync(answerFile)) {
      const content = fs.readFileSync(answerFile, 'utf-8');
      if (content.trim().length > 0) return content;
    }
  }
  return undefined;
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
  filesBlock: string,
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
      filesBlock,
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
  filesBlock: string,
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

  const ask = buildReviewerAsk(phase, phaseIdx, round, work, doerOutput, filesBlock);
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

// Per-file cap and total cap when inlining attached files into a prompt.
// Numbers chosen to keep prompts comfortably within Anthropic / OpenAI / Google
// 1M-token budgets while still surfacing realistic source files. Hardcoded
// for now; if template authors need larger payloads we'd lift these into
// template config (template.inputs.maxFileBytes / maxTotalBytes).
const ATTACHED_FILE_MAX_BYTES = 64 * 1024;
const ATTACHED_FILES_TOTAL_BYTES = 256 * 1024;

function packAttachedFiles(paths: string[] | undefined, repoPath: string | undefined): string {
  if (!paths || paths.length === 0) return '';

  const chunks: string[] = [];
  let totalBytes = 0;

  for (const rel of paths) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoPath ?? process.cwd(), rel);
    const display = path.isAbsolute(rel) ? path.relative(repoPath ?? process.cwd(), abs) || abs : rel;

    if (!fs.existsSync(abs)) {
      chunks.push(`### \`${display}\` — _file not found, skipping_`);
      continue;
    }

    let body: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) {
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
      chunks.push(`### \`${display}\` — _skipped: would exceed ${ATTACHED_FILES_TOTAL_BYTES}-byte total cap_`);
      continue;
    }

    totalBytes += slice.length;
    const ext = path.extname(display).slice(1) || '';
    chunks.push(`### \`${display}\`${truncated ? ` (truncated to ${ATTACHED_FILE_MAX_BYTES} bytes)` : ''}\n\`\`\`${ext}\n${slice}\n\`\`\``);
  }

  if (chunks.length === 0) return '';
  return ['## Attached files', '', ...chunks, ''].join('\n');
}

function buildAsk(
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  inputs: Phase['inputs'],
  filesBlock: string
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

function buildReviewerAsk(
  phase: Phase,
  phaseIdx: number,
  round: number,
  work: string,
  doerOutput: string,
  filesBlock: string
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
    'Do you approve? Answer: approve or request changes, end with: ## DONE'
  );

  return lines.join('\n');
}
