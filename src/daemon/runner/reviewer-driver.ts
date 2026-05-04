import fs from 'fs';
import path from 'path';
import { DEFAULT_TMUX_PHASE_TIMEOUT_MS, type StandardPhase } from '../../lib/template-schema.js';
import { recordHealth, kindToStatus, type CliLineage } from '../../lib/cli-health.js';
import { precheckLineage } from '../../lib/cli-precheck.js';
import { personas } from '../../lib/db/index.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import { getTransport } from '../../lib/settings/transport.js';
import { isHttpDispatchedShim, pickShimForVoice } from '../agents/index.js';
import type { ErrorDetector } from '../error-detector.js';
import { waitForAnswer } from '../output-watcher.js';
import * as participantAborts from '../participant-aborts.js';
import type { TmuxManager } from '../tmux-types.js';
import { buildReviewerAsk } from './prompt-builder.js';
import { runReviewerHeadless } from './reviewer.js';
import { runWithChainFallback, runWithModelFallback } from './run-with-fallback.js';
import { sanitizeName } from './sanitize-name.js';
import { appendSwapSidecar } from './swap-sidecar.js';
import { buildSlotFallbackChain } from './template-fallback.js';
import type { Lineage } from '../agents/types.js';
import type { RunnerEvent } from './types.js';
import { verdictFromReviewerText } from './verdict.js';

// Cap concurrent reviewer subprocesses per chat. Templates with 4+
// reviewer candidates would otherwise spawn the full set in parallel —
// which in practice means simultaneous LLM-CLI subprocesses each holding
// a shim child + stream parser, plus per-chat cwd. At load=133 last week
// the root cause was unbounded fan-out across re-attached SSE sessions;
// the per-chat ceiling stops a single big template from melting the host.
const REVIEWER_CONCURRENCY = 3;

export async function runReviewers(
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
  templateFallbackReviewer?: ReadonlyArray<{ lineage: string; models: string[] }>,
): Promise<{ agreed: boolean; summary: string; allFailed: boolean }> {
  if (!phase.reviewer || phase.reviewer.candidates.length === 0) {
    return { agreed: true, summary: '', allFailed: false };
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true });
  }

  // 'failed' = reviewer never produced a valid answer (timeout/quota/crash).
  // The chat-level verdict has to know the difference: if EVERY reviewer
  // failed, we shouldn't auto-approve.
  const reviews: {
    reviewer: string;
    outcome: 'agreed' | 'disagreed' | 'failed';
  }[] = [];

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
          templateFallbackReviewer,
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
  templateFallbackReviewer?: ReadonlyArray<{ lineage: string; models: string[] }>,
): Promise<boolean | null> {
  // Returns:
  //   true  = reviewer ran and approved
  //   false = reviewer ran and disagreed
  //   null  = reviewer never produced a valid answer (timeout/quota/crash)
  if (!phase.reviewer) return true;
  const candidate = phase.reviewer.candidates[reviewerIdx];

  const reviewerModel = candidate.models?.[0];
  const shim = pickShimForVoice(candidate.lineage, reviewerModel);
  const agentName = shim.name;

  // Pre-spawn precheck — same gate as runDoer. A reviewer that fails
  // precheck returns null, which the phase loop already handles by
  // counting it toward the all-reviewers-failed threshold and continuing
  // with the remaining reviewers. HTTP-dispatched shims (openrouter)
  // skip this — auth is the secrets table, checked inside the shim.
  if (!isHttpDispatchedShim(shim)) {
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

  // Per-slot model fallback: when candidate.models lists multiple models
  // we try them in order, falling through on `null` (no answer produced).
  // The boolean verdict `false` (disagreement) is a real result and stops
  // the chain — runWithModelFallback only re-tries on literal null.
  const transport = await getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    const handle = participantAborts.register(
      chatId,
      participantAborts.participantKey('reviewer', agentName, reviewerIdx),
      abortSignal,
    );
    try {
      // Compose: this slot's per-slot chain + template-level
      // fallback.reviewer (same lineage, dedup'd against this slot AND
      // every other reviewer slot in the phase so we don't spawn a
      // duplicate voice).
      const allReviewerSlots = (phase.reviewer?.candidates ?? []).map((c) => ({
        lineage: c.lineage,
        models: c.models ?? [],
      }));
      const thisSlot = {
        lineage: candidate.lineage,
        models: candidate.models ?? [],
      };
      const chain = buildSlotFallbackChain(
        thisSlot,
        allReviewerSlots,
        templateFallbackReviewer,
      );
      return await runWithChainFallback(
        chain,
        async (entry) => {
          // Cross-lineage swap: when the entry's lineage differs from the
          // slot's primary, re-resolve the shim. The slot's identity
          // (agentName, reviewerDir, participant key) stays bound to the
          // primary lineage so the cockpit card doesn't re-key mid-run —
          // the cli_warning below tells the UI a swap happened.
          const entryShim = entry.lineage === candidate.lineage
            ? shim
            : pickShimForVoice(entry.lineage as Lineage, entry.model);
          return runReviewerHeadless({
            shim: entryShim,
            chatId,
            phase,
            round,
            reviewerIdx,
            candidateLineage: entry.lineage,
            candidateModel: entry.model,
            agentName,
            askContent: ask,
            answerFile,
            reviewerDir,
            abortSignal: handle.signal,
            onEvent,
          });
        },
        (from, to, fromIdx) => {
          const sameLineage = from.lineage === to.lineage;
          const reason = sameLineage ? 'model_fallback' : 'lineage_fallback';
          const message = sameLineage
            ? `Reviewer model "${from.model ?? '(default)'}" produced no answer; retrying with "${to.model ?? '(default)'}".`
            : `Reviewer ${from.lineage}/${from.model ?? '(default)'} failed; switching to ${to.lineage}/${to.model ?? '(default)'} (cross-lineage fallback).`;
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
              reason,
              fromLineage: from.lineage,
              toLineage: to.lineage,
              fromModel: from.model ?? '(default)',
              toModel: to.model ?? '(default)',
              fallbackIdx: fromIdx,
              message,
            },
            ts: Date.now(),
          });
          // Persist a sidecar so swap cards survive page reloads — the
          // SSE stream shuts off for terminal chats, and phase_events
          // packs warnings as opaque text. Mirrors the _stats.json /
          // _meta.json pattern: append-only JSON array, read by the
          // run-artifacts route at the next refresh tick.
          appendSwapSidecar(reviewerDir, {
            round,
            phaseId: phase.id,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            reason,
            fromLineage: from.lineage,
            toLineage: to.lineage,
            fromModel: from.model ?? '(default)',
            toModel: to.model ?? '(default)',
            fallbackIdx: fromIdx,
            ts: Date.now(),
          });
        },
      );
    } finally {
      handle.release();
    }
  }

  // Reviewers don't share sessions across rounds — each round wants a
  // fresh perspective on the new doer output. Across-phase reuse never
  // makes sense.
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
  // Wait for the CLI's TUI to finish cold-start before pasting (6s
  // covers Codex's slow cold-start). See doer-driver for rationale.
  await new Promise((r) => setTimeout(r, 6000));

  tmuxMgr.pasteBuffer(session.name, prompt);
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
          // Fire-and-forget — see doer-driver for rationale.
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
