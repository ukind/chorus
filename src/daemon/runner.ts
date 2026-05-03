/**
 * Phase runner — orchestrates template execution.
 * Spawns CLI sessions per phase/round/role, writes prompts, watches for answers,
 * handles reviewer consensus, and emits SSE events to the client.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Template, Phase, StandardPhase, ReviewOnlyPhase } from '../lib/template-schema.js';
import { isReviewOnlyPhase, DEFAULT_TMUX_PHASE_TIMEOUT_MS } from '../lib/template-schema.js';
import { waitForAnswer } from './output-watcher.js';

import type { TmuxManager } from './tmux-types.js';
import { registry } from './agents/index.js';
import { ErrorDetector } from './error-detector.js';
import { getPermissions } from '../lib/settings/permissions.js';
import { personas } from '../lib/db/index.js';
import * as participantAborts from './participant-aborts.js';
import { getTransport } from '../lib/settings/transport.js';
import { recordHealth, kindToStatus, type CliLineage } from '../lib/cli-health.js';
import { precheckLineage } from '../lib/cli-precheck.js';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
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
    | 'chat_done'
    | 'participant_done';
  payload: Record<string, unknown>;
  ts: number;
}

export interface PhaseRunnerOptions {
  chatId: string;
  template: Template;
  work: string;
  /**
   * Artifact text for review-only phases. When the template's first phase
   * has `kind: review_only`, this MUST be supplied (the chat-create endpoint
   * enforces it). The runner writes it into a synthetic doer-answer slot
   * and emits synthetic doer phase events so reviewers see the same shape
   * they always do.
   */
  artifact?: string;
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
  const { chatId, template, work, artifact, repoPath, attachedFiles, onEvent, abortSignal, tmuxMgr, errorDetector } = opts;
  const chatDir = path.join(os.homedir(), '.chorus', 'chats', chatId);

  // Pack attached files into a single block once per chat. Both doer + every
  // reviewer get the same block — they're auditing the same artifacts.
  const filesBlock = packAttachedFiles(attachedFiles, repoPath);

  // Ensure chat directory
  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }

  // Write meta — atomic temp+rename so a partial write (daemon crash, FS
  // ENOSPC mid-fsync) can't leave a corrupt JSON that the cockpit chokes on.
  const meta: ChatMeta = {
    chatId,
    work,
    templateId: template.id,
    createdAt: Date.now(),
  };
  atomicWriteJsonSync(path.join(chatDir, 'meta.json'), meta);

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
  // Captures the consensus from the most recent review-only phase. Used to
  // override the default 'approved' verdict in chat_done — review-only chats
  // surface what the reviewers actually said rather than auto-approving.
  // null when no review-only phase ran (standard templates).
  let reviewOnlyConsensus: { agreed: boolean; summary: string } | null = null;

  try {
    // Walk phases
    for (let phaseIdx = 0; phaseIdx < template.phases.length; phaseIdx++) {
      if (abortSignal.aborted) break;

      const phase = template.phases[phaseIdx];

      // Review-only phases skip the doer entirely. The artifact supplied at
      // chat-create time becomes the synthetic doer answer; reviewers run
      // exactly as in standard phases. Single pass, no iterate loop, no
      // ship — those are enforced here, not in the schema, so that future
      // hybrid templates can mix kinds without re-plumbing the validator.
      if (isReviewOnlyPhase(phase)) {
        const outcome = await runReviewOnlyPhase({
          chatDir,
          chatId,
          phase,
          phaseIdx,
          artifact: artifact ?? '',
          work,
          filesBlock,
          tmuxMgr,
          errorDetector,
          onEvent,
          abortSignal,
        });
        if (outcome.allReviewersFailed) {
          anyPhaseAllReviewersFailed = true;
        }
        if (!outcome.completed) {
          // Aborted (Ctrl-C / cockpit cancel). DO NOT capture consensus —
          // emitChatDone is racing with the abort listener which fires
          // status='cancelled', and surfacing 'request_changes' here would
          // collapse "user hit cancel" with "reviewers said no" if the
          // abort listener loses the latch race. The break exits the phase
          // loop; the chat_done branch below trips the standard-flow
          // 'completed' path which emitChatDone already latched against.
          break;
        }
        // Reviewers actually finished a pass. Capture so chat_done can
        // surface the real verdict instead of always reporting 'approved'.
        reviewOnlyConsensus = {
          agreed: outcome.agreed,
          summary: outcome.summary,
        };
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
        continue;
      }

      // Standard phase from here on. Narrow the discriminator so the
      // existing doer/iterate code keeps its types.
      const stdPhase: StandardPhase = phase;

      // Run doer loop with retries
      let doerSucceeded = false;
      for (
        let round = 1;
        round <= stdPhase.iterate.maxRounds;
        round++
      ) {
        if (abortSignal.aborted) break;

        onEvent({
          chatId,
          type: 'phase_start',
          payload: {
            phaseId: stdPhase.id,
            phaseIdx,
            kind: stdPhase.kind,
            round,
            role: 'doer',
            agent: stdPhase.doer.lineage,
          },
          ts: Date.now(),
        });

        // Spawn doer
        const doerAnswer = await runDoer(
          chatDir,
          chatId,
          stdPhase,
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
              phaseId: stdPhase.id,
              phaseIdx,
              kind: stdPhase.kind,
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
            phaseId: stdPhase.id,
            round,
            role: 'doer',
            output: doerAnswer.content.slice(0, 500),
          },
          ts: Date.now(),
        });

        // Run reviewers if present
        if (stdPhase.reviewer && stdPhase.reviewer.candidates.length > 0) {
          const consensus = await runReviewers(
            chatDir,
            chatId,
            stdPhase,
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
          if (round < stdPhase.iterate.maxRounds) {
            onEvent({
              chatId,
              type: 'phase_progress',
              payload: {
                phaseId: stdPhase.id,
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
            phaseId: stdPhase.id,
            phaseIdx,
            kind: stdPhase.kind,
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
          phaseId: stdPhase.id,
          phaseIdx,
          kind: stdPhase.kind,
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

    // Ship is forcibly skipped when any phase is review_only — there's no
    // doer diff to commit and a template author who set ship.enabled=true on
    // a review-only template would otherwise hit gh-cli with an empty stage.
    // The schema docs claim the runner enforces this; this is the
    // enforcement point.
    const templateHasReviewOnly = template.phases.some(isReviewOnlyPhase);
    if (
      !anyPhaseAllReviewersFailed &&
      !anyPhaseDoerFailed &&
      !templateHasReviewOnly &&
      template.ship?.enabled &&
      repoPath
    ) {
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
    } else if (reviewOnlyConsensus !== null) {
      // Review-only chats surface the actual reviewer consensus rather than
      // auto-approving. The chat itself completed (artifact reviewed,
      // findings written) regardless of agreement — that's the design — but
      // verdict reflects what reviewers said so the cockpit/CLI can render
      // a meaningful "agreed / requested changes" state instead of always
      // showing green.
      emitChatDone({
        status: 'completed',
        verdict: reviewOnlyConsensus.agreed ? 'approved' : 'request_changes',
        reviewerSummary: reviewOnlyConsensus.summary,
      });
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

async function runDoer(
  chatDir: string,
  chatId: string,
  phase: StandardPhase,
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

  // Pre-spawn precheck: short-circuit doomed runs without paying the spawn
  // tax. Two cheap layers: (1) recent quota_exhausted with future resetAt,
  // (2) credential file missing → user not logged in. See cli-precheck.ts.
  const preDoer = await precheckLineage(phase.doer.lineage as CliLineage);
  if (!preDoer.ok) {
    onEvent({
      chatId,
      type: 'cli_warning',
      payload: {
        phaseId: phase.id,
        round,
        role: 'doer',
        agent: agentName,
        lineage: phase.doer.lineage,
        reason: preDoer.reason,
        message: preDoer.message,
        cta: preDoer.cta,
        resetAt: preDoer.resetAt,
      },
      ts: Date.now(),
    });
    return null;
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  const doerDir = path.join(roundDir, `doer-${agentName}`);

  if (!fs.existsSync(doerDir)) {
    fs.mkdirSync(doerDir, { recursive: true });
  }

  const askFile = path.join(doerDir, 'ask.md');
  const answerFile = path.join(doerDir, 'answer.md');

  // Resolve doer persona (if any). Falls back to no-persona prompt when
  // the id can't be resolved — but emits cli_warning so the cockpit can
  // surface the misconfiguration. Without the warning, retroactive PR #17
  // review (gemini + opencode-deepseek + opencode-kimi) flagged that a
  // user typoing a persona id silently runs the chat with a generic
  // prompt and no UX signal.
  let doerPersonaPrompt: string | undefined;
  if ('persona' in phase.doer && phase.doer.persona) {
    const personaId = phase.doer.persona;
    try {
      const row = await personas.getById(personaId);
      if (row) {
        doerPersonaPrompt = row.system_prompt;
      } else {
        onEvent({
          chatId,
          type: 'cli_warning',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            round,
            role: 'doer',
            agent: agentName,
            kind: 'persona_missing',
            message: `Doer persona "${personaId}" not found in personas table — running with generic prompt. Check the template's doer.persona field.`,
          },
          ts: Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          phaseIdx,
          round,
          role: 'doer',
          agent: agentName,
          kind: 'persona_lookup_failed',
          message: `Doer persona lookup for "${personaId}" failed: ${message} — running with generic prompt.`,
        },
        ts: Date.now(),
      });
    }
  }

  // Write ask.md (the prompt body the CLI reads).
  const ask = buildAsk(
    phase,
    phaseIdx,
    round,
    work,
    phase.inputs,
    filesBlock,
    doerPersonaPrompt,
  );
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
  const transport = await getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    // Register the doer for per-card cancel. Same combined-signal pattern
    // as the reviewer path — chat-cancel still aborts everything.
    const handle = participantAborts.register(
      chatId,
      participantAborts.participantKey('doer', agentName),
      abortSignal,
    );
    try {
      return await runDoerHeadless({
        shim,
        chatId,
        phase,
        round,
        agentName,
        askContent: ask,
        answerFile,
        doerCwd,
        abortSignal: handle.signal,
        onEvent,
      });
    } finally {
      handle.release();
    }
  }

  // Acquire session — fresh per chat by default; reuses across rounds when
  // template policy says so (shareSessionAcrossRounds, default true).
  const perms = await getPermissions();
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
          // Fire-and-forget — recordHealth became async in the libsql
          // migration. Inside a setInterval callback we can't await without
          // changing the callback shape; explicit .catch keeps unhandled
          // rejections off the process and preserves the pre-migration
          // semantics (non-blocking health record).
          recordHealth({
            lineage: phase.doer.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          }).catch((healthErr: unknown) => {
            console.error(`[chorus] recordHealth failed for ${phase.doer.lineage}:`, healthErr);
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
      timeoutMs: phase.timeoutMs ?? DEFAULT_TMUX_PHASE_TIMEOUT_MS,
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
// StreamFileWriter moved to ./runner/stream-file-writer.ts; re-exported above.

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
  phase: StandardPhase,
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

  // Cap concurrent reviewer subprocesses per chat. Templates with 4+ reviewer
  // candidates would otherwise spawn the full set in parallel — which in
  // practice means simultaneous LLM-CLI subprocesses each holding a shim
  // child + stream parser, plus per-chat cwd. At load=133 last week the
  // root cause was unbounded fan-out across re-attached SSE sessions; we
  // also want a per-chat ceiling so a single big template doesn't melt the
  // host on its own.
  const REVIEWER_CONCURRENCY = 3;
  const candidates = phase.reviewer.candidates;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) return;
      const candidate = candidates[idx];
      try {
        const res = await runReviewer(
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
        );
        reviews.push({
          reviewer: `${candidate.lineage}-${idx}`,
          outcome: res === null ? 'failed' : res ? 'agreed' : 'disagreed',
        });
      } catch {
        reviews.push({
          reviewer: `${candidate.lineage}-${idx}`,
          outcome: 'failed',
        });
      }
    }
  }
  const workerCount = Math.min(REVIEWER_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

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

// Headless reviewer execution moved to ./runner/reviewer.ts; re-exported above.

/**
 * Extract an approve/disagree/null verdict from a reviewer's free-form text.
 *
 * The prior heuristic was `text.includes('approve') || text.includes('good')`
 * which produced two failure modes that bit us in the first audit run:
 *   1. False positive: any reviewer that mentioned "good practice" or "the
 *      approach is good" anywhere in a critical review was scored as approved.
 *   2. False negative-as-disagreement: an empty / near-empty reviewer response
 *      (e.g. Gemini emitting only "## DONE") was scored as disagreed because
 *      the words weren't present. But empty != disagreed — the reviewer
 *      simply didn't engage. Treating it as disagreement triggered useless
 *      extra rounds.
 *
 * New rules:
 *   - Strip the ## DONE sentinel and any trailing whitespace.
 *   - If less than 80 chars of substantive content remain, return null
 *     (failed — caller treats as no-review).
 *   - Look at the LAST 400 chars (where verdicts typically live) for explicit
 *     keywords: "request changes" / "disagree" / "reject" / "blocker" win
 *     first (negative dominates), then "approve" / "lgtm".
 *   - If neither pattern fires, return null (ambiguous → failed).
 *
 * The right long-term fix is a structured `## VERDICT: APPROVE|REQUEST_CHANGES`
 * footer in the reviewer prompt + strict parser. Tracked in ROADMAP #23.
 */
// verdictFromReviewerText was extracted to ./runner/verdict.ts; re-export
// from this module so MCP and other consumers keep working.
import { verdictFromReviewerText } from './runner/verdict.js';
export { verdictFromReviewerText };

async function runReviewer(
  chatDir: string,
  chatId: string,
  phase: StandardPhase,
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

  // Pre-spawn precheck — same gate as runDoer. A reviewer that fails precheck
  // is treated as "never produced a valid answer" (returns null), which the
  // phase loop already handles by counting it toward the all-reviewers-failed
  // threshold and continuing with the remaining reviewers.
  const preRev = await precheckLineage(candidate.lineage as CliLineage);
  if (!preRev.ok) {
    onEvent({
      chatId,
      type: 'cli_warning',
      payload: {
        phaseId: phase.id,
        round,
        role: 'reviewer',
        agent: `${agentName}-${reviewerIdx}`,
        lineage: candidate.lineage,
        reason: preRev.reason,
        message: preRev.message,
        cta: preRev.cta,
        resetAt: preRev.resetAt,
      },
      ts: Date.now(),
    });
    return null;
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  const reviewerDir = path.join(roundDir, `reviewer-${agentName}-${reviewerIdx}`);

  if (!fs.existsSync(reviewerDir)) {
    fs.mkdirSync(reviewerDir, { recursive: true });
  }

  const askFile = path.join(reviewerDir, 'ask.md');
  const answerFile = path.join(reviewerDir, 'answer.md');

  // Resolve reviewer persona — same fallback + warning pattern as runDoer.
  let reviewerPersonaPrompt: string | undefined;
  if (candidate.persona) {
    const personaId = candidate.persona;
    try {
      const row = await personas.getById(personaId);
      if (row) {
        reviewerPersonaPrompt = row.system_prompt;
      } else {
        onEvent({
          chatId,
          type: 'cli_warning',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            kind: 'persona_missing',
            message: `Reviewer persona "${personaId}" not found in personas table — running with generic prompt. Check the template's reviewer candidate persona field.`,
          },
          ts: Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          phaseIdx,
          round,
          role: 'reviewer',
          agent: `${agentName}-${reviewerIdx}`,
          kind: 'persona_lookup_failed',
          message: `Reviewer persona lookup for "${personaId}" failed: ${message} — running with generic prompt.`,
        },
        ts: Date.now(),
      });
    }
  }

  const ask = buildReviewerAsk(
    phase,
    phaseIdx,
    round,
    work,
    doerOutput,
    filesBlock,
    reviewerPersonaPrompt,
  );
  fs.writeFileSync(askFile, ask);

  // Headless branch — same pattern as runDoer. Mixed-mode is fine: doer can
  // run headless while a reviewer of a different lineage falls back to tmux.
  const transport = await getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    // Register this reviewer for per-card cancel. The combined signal
    // fires when EITHER the chat-wide signal aborts OR the cockpit hits
    // /chats/:id/participants/:key/cancel for this slot.
    const handle = participantAborts.register(
      chatId,
      participantAborts.participantKey('reviewer', agentName, reviewerIdx),
      abortSignal,
    );
    try {
      return await runReviewerHeadless({
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
        abortSignal: handle.signal,
        onEvent,
      });
    } finally {
      handle.release();
    }
  }

  // Reviewers don't share sessions across rounds — each round wants a fresh
  // perspective on the new doer output. Across-phase reuse never makes sense.
  const perms = await getPermissions();
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
          // See doer-side comment at runner.ts:507 — same fire-and-forget
          // pattern for the async recordHealth inside a setInterval cb.
          recordHealth({
            lineage: candidate.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          }).catch((healthErr: unknown) => {
            console.error(`[chorus] recordHealth failed for ${candidate.lineage}:`, healthErr);
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
      timeoutMs: phase.timeoutMs ?? DEFAULT_TMUX_PHASE_TIMEOUT_MS,
      doneSentinel: '## DONE',
    });
    if (!result.full || result.content.trim().length === 0) {
      // Watcher resolved on timeout/silence with no real answer.
      return null;
    }
    return verdictFromReviewerText(result.content);
  } catch {
    // Timed out or watcher errored — no valid answer produced.
    return null;
  } finally {
    clearInterval(pollHandle);
  }
}

/**
 * Run a review-only phase. The artifact (supplied at chat-create time) is
 * written to a synthetic doer answer slot; reviewers then critique it just
 * like a real doer's answer. Single pass — no iterate, no retry. Reviewer
 * agreement/disagreement is reported via outcome.allReviewersFailed; the
 * verdict itself doesn't gate further phases (review-only is the whole
 * point of the chat).
 *
 * Synthetic doer events make the cockpit + replay code paths Just Work
 * without special-casing the missing doer card.
 */
async function runReviewOnlyPhase(args: {
  chatDir: string;
  chatId: string;
  phase: ReviewOnlyPhase;
  phaseIdx: number;
  artifact: string;
  work: string;
  filesBlock: string;
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
}): Promise<{
  completed: boolean;
  allReviewersFailed: boolean;
  /** True iff reviewer agreement met phase.reviewer.require threshold. */
  agreed: boolean;
  /** Human-readable summary line ('2/3 reviewers agreed' etc.). */
  summary: string;
}> {
  const {
    chatDir,
    chatId,
    phase,
    phaseIdx,
    artifact,
    work,
    filesBlock,
    tmuxMgr,
    errorDetector,
    onEvent,
    abortSignal,
  } = args;

  if (abortSignal.aborted) {
    return { completed: false, allReviewersFailed: false, agreed: false, summary: 'aborted' };
  }

  const round = 1; // review-only is always single-pass
  const roundDir = path.join(chatDir, `round-${round}`);
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true });
  }
  // Synthetic doer dir holds the artifact as answer.md so the cockpit's
  // existing replay code finds it under the same path shape it expects.
  const syntheticDoerDir = path.join(roundDir, 'doer-artifact');
  if (!fs.existsSync(syntheticDoerDir)) {
    fs.mkdirSync(syntheticDoerDir, { recursive: true });
  }
  const answerFile = path.join(syntheticDoerDir, 'answer.md');
  // Strip trailing whitespace before the sentinel check so an artifact
  // ending with "## DONE\n" or "## DONE  " doesn't produce a duplicate
  // sentinel after we append. Idempotent: artifacts without the sentinel
  // get a clean "\n\n## DONE\n" tail.
  const trimmed = artifact.replace(/\s+$/, '');
  const artifactWithSentinel = /##\s*DONE$/i.test(trimmed)
    ? `${trimmed}\n`
    : `${trimmed}\n\n## DONE\n`;
  fs.writeFileSync(answerFile, artifactWithSentinel);

  // Synthetic doer phase events. agent='artifact' is a sentinel value the
  // cockpit can render as "user-supplied" rather than as a real CLI run.
  onEvent({
    chatId,
    type: 'phase_start',
    payload: {
      phaseId: phase.id,
      phaseIdx,
      kind: phase.kind,
      round,
      role: 'doer',
      agent: 'artifact',
      synthetic: true,
    },
    ts: Date.now(),
  });
  onEvent({
    chatId,
    type: 'phase_progress',
    payload: {
      phaseId: phase.id,
      round,
      role: 'doer',
      agent: 'artifact',
      output: artifact.slice(0, 500),
      synthetic: true,
    },
    ts: Date.now(),
  });

  // Run reviewers exactly as standard phases do, but only for round 1.
  // The runReviewers helper expects a StandardPhase shape — we synthesise
  // one that carries the same reviewer block + a no-op iterate config.
  // The synthetic shape is local to this call; it never escapes back into
  // the template.
  const syntheticStandardPhase: StandardPhase = {
    id: phase.id,
    kind: 'review',
    title: phase.title,
    description: phase.description,
    doer: { lineage: 'any' },
    reviewer: phase.reviewer,
    inputs: phase.inputs,
    iterate: {
      maxRounds: 1,
      onDisagreement: 'continue',
      shareSessionAcrossRounds: false,
      shareSessionAcrossPhases: false,
    },
    timeoutMs: phase.timeoutMs,
  };

  const consensus = await runReviewers(
    chatDir,
    chatId,
    syntheticStandardPhase,
    phaseIdx,
    round,
    artifact,
    work,
    filesBlock,
    tmuxMgr,
    errorDetector,
    onEvent,
    abortSignal,
  );

  return {
    completed: !abortSignal.aborted,
    allReviewersFailed: consensus.allFailed,
    agreed: consensus.agreed,
    summary: consensus.summary,
  };
}

// Pure prompt-construction helpers live in ./runner/prompt-builder.ts so
// they can be unit-tested without standing up the full runner. Import
// here and re-export so the rest of this file (and external callers via
// require('./runner.js')) keep working.
import {
  packAttachedFiles,
  buildAsk,
  buildReviewerAsk,
} from './runner/prompt-builder.js';
export { packAttachedFiles, buildAsk, buildReviewerAsk };

// Streaming hot paths now live in their own modules. runner.ts keeps the
// orchestration (runChat, runDoer, runReviewer, runReviewers) so the
// closure on registry / tmuxMgr / errorDetector stays coherent.
import { runDoerHeadless } from './runner/doer.js';
import { runReviewerHeadless } from './runner/reviewer.js';
import { StreamFileWriter } from './runner/stream-file-writer.js';
export { runDoerHeadless, runReviewerHeadless, StreamFileWriter };
