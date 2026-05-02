/**
 * Integration tests for runReviewerHeadless.
 *
 * Same shape as the doer tests but the reviewer returns boolean | null
 * (the verdict) instead of {content, full}. Verifies that approve / disagree
 * text is correctly extracted from streamed deltas and that empty / errored
 * paths fail closed (null).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReviewerHeadless } from '../src/daemon/runner';
import type { Phase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';
import { makeFakeShim, happyPathEvents } from './helpers/fake-agent-shim';

let tmp: string;
let reviewerDir: string;
let answerFile: string;
let events: RunnerEvent[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-reviewer-'));
  reviewerDir = path.join(tmp, 'reviewer-codex-0');
  fs.mkdirSync(reviewerDir, { recursive: true });
  answerFile = path.join(reviewerDir, 'answer.md');
  events = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fixturePhase: Phase = {
  id: 'review',
  kind: 'review',
  title: 'Code Review',
  description: '',
  doer: { lineage: 'anthropic', models: ['claude-opus-4-7'] },
  reviewer: {
    require: 1,
    crossLineage: true,
    candidates: [{ lineage: 'openai', models: ['gpt-5.5'] }],
  },
  inputs: { include: [], exclude: [] },
  iterate: {
    maxRounds: 1,
    onDisagreement: 'continue',
    shareSessionAcrossRounds: false,
    shareSessionAcrossPhases: false,
  },
} as unknown as Phase;

const PADDING =
  'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3);

const callReviewer = (shimHandle: ReturnType<typeof makeFakeShim>) =>
  runReviewerHeadless({
    shim: shimHandle.shim,
    chatId: 'test-chat',
    phase: fixturePhase,
    round: 1,
    reviewerIdx: 0,
    candidateLineage: 'openai',
    candidateModel: 'gpt-5.5',
    agentName: 'codex-cli',
    askContent: 'review the doer output',
    answerFile,
    reviewerDir,
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });

describe('runReviewerHeadless', () => {
  it('returns true when reviewer text approves at the tail', async () => {
    const text = `${PADDING}\nThis change handles divide-by-zero correctly. lgtm.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(true);
  });

  it('returns false when reviewer requests changes', async () => {
    const text = `${PADDING}\nMissing input validation; request changes.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(false);
  });

  it('returns null on ambiguous text (no positive/negative match)', async () => {
    const text = `${PADDING} ${PADDING} the code seems consistent with the rest of the codebase.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream errors with no content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'limit hit' }],
    });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream is silent (no message_done, no deltas)', async () => {
    const handle = makeFakeShim({ events: [] });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('preserves streamed deltas to disk when finalText is empty', async () => {
    const text = `${PADDING}\nlgtm — ship it`;
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text },
        { type: 'message_done', finalText: '' },
      ],
    });
    const verdict = await callReviewer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('lgtm');
    expect(verdict).toBe(true);
  });

  it('emits cli_warning when answer.md write fails (StreamFileWriter dies mid-stream)', async () => {
    // Force the writer dead: runReviewerHeadless does an initial
    // `fs.writeFileSync(answerFile, '')` to create the file, then
    // constructs StreamFileWriter against it. We let the create succeed,
    // but chmod the file to read-only AFTER the create, BEFORE the
    // text_delta flush — by short-circuiting via a fake shim that fires
    // text_delta on first iteration.
    //
    // Chmod hook is delivered through the fake shim: the first event the
    // shim yields is a text_delta large enough to trigger an immediate
    // flush; we chmod inside an async iterator step BEFORE that delta is
    // emitted. Plain happyPathEvents has no hook, so we hand-roll one.
    async function* hostileStream(): AsyncIterable<{ type: 'text_delta' | 'message_done'; text?: string; finalText?: string }> {
      // Run AFTER runReviewerHeadless's initial fs.writeFileSync(answerFile,'').
      fs.chmodSync(answerFile, 0o444);
      // Buffer crosses the flush threshold (4KB). The synchronous
      // appendFileSync then fails with EACCES, flipping the writer dead.
      yield { type: 'text_delta', text: 'x'.repeat(8192) };
      yield { type: 'message_done', finalText: '' };
    }
    const fakeShim = makeFakeShim({ events: [] });
    fakeShim.shim.runHeadless = () => hostileStream() as never;

    await callReviewer(fakeShim);

    // Restore perms so afterEach rmSync can clean up.
    try { fs.chmodSync(answerFile, 0o644); } catch { /* best-effort */ }

    const warning = events.find(
      (e) =>
        e.type === 'cli_warning' &&
        (e.payload as { reason?: string }).reason === 'stream_writer_dead',
    );
    expect(warning).toBeDefined();
    const payload = warning!.payload as { role?: string; agent?: string };
    expect(payload.role).toBe('reviewer');
    expect(payload.agent).toBe('codex-cli-0');
  });
});
