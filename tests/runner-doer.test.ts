/**
 * Integration tests for runDoerHeadless.
 *
 * Drives the real runner code with a FakeAgentShim instead of a real CLI
 * subprocess. Confirms the contracts that earlier hand-debugging surfaced:
 *
 *   - `text_delta` events accumulate AND get flushed to answer.md
 *   - `message_done` with non-empty finalText overwrites answer.md
 *     authoritatively + appends ## DONE sentinel when missing
 *   - `message_done` with EMPTY finalText keeps accumulated deltas in
 *     place (the Gemini `result-line-only` bug)
 *   - `error` event flips errored AND preserves accumulated content
 *   - aborted stream returns null when no content was streamed
 *   - StreamFileWriter buffer is flushed in the finally block on every path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoerHeadless } from '../src/daemon/runner';
import type { Phase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';
import { makeFakeShim, happyPathEvents } from './helpers/fake-agent-shim';

let tmp: string;
let answerFile: string;
let events: RunnerEvent[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doer-'));
  answerFile = path.join(tmp, 'answer.md');
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

const callDoer = (shimHandle: ReturnType<typeof makeFakeShim>) =>
  runDoerHeadless({
    shim: shimHandle.shim,
    chatId: 'test-chat',
    phase: fixturePhase,
    round: 1,
    agentName: 'fake',
    askContent: 'do the thing',
    answerFile,
    doerCwd: tmp,
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });

describe('runDoerHeadless', () => {
  it('happy path: streams deltas + finalText, returns full content with DONE sentinel', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents('I made the fix.\n\nLooks good.\n## DONE'),
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.full).toBe(true);
    expect(res!.content).toContain('I made the fix.');
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('I made the fix.');
    expect(written).toMatch(/##\s*DONE/);
  });

  it('appends ## DONE sentinel when finalText lacks it', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'partial' },
        { type: 'message_done', finalText: 'authoritative final answer here' },
      ],
    });
    await callDoer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('authoritative final answer here');
    expect(written).toMatch(/##\s*DONE/);
  });

  it('preserves accumulated deltas when message_done.finalText is empty', async () => {
    // Gemini's "result line is empty after streaming many deltas" failure
    // mode. Earlier code overwrote answer.md with just `## DONE`, wiping
    // the live stream. Now: we keep the deltas, append DONE if missing.
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'streaming chunk one\n' },
        { type: 'text_delta', text: 'streaming chunk two\n' },
        { type: 'message_done', finalText: '' },
      ],
    });
    const res = await callDoer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('streaming chunk one');
    expect(written).toContain('streaming chunk two');
    expect(written).toMatch(/##\s*DONE/);
    expect(res!.content).toContain('streaming chunk');
  });

  it('emits phase_progress events for every text_delta', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('three chunks here', { chunks: 3 }) });
    await callDoer(handle);
    const progress = events.filter(
      (e) => e.type === 'phase_progress' && e.payload.role === 'doer',
    );
    expect(progress.length).toBeGreaterThanOrEqual(3);
  });

  it('emits cli_error and returns null when stream errors with no content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'rate limited' }],
    });
    const res = await callDoer(handle);
    expect(res).toBeNull();
    const cliError = events.find((e) => e.type === 'cli_error');
    expect(cliError).toBeDefined();
    expect((cliError!.payload.error as { kind: string }).kind).toBe('quota_exhausted');
  });

  it('keeps accumulated content even when a final error event fires', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'partial answer before crash\n' },
        { type: 'error', kind: 'crashed', message: 'subprocess died' },
      ],
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.content).toContain('partial answer before crash');
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('partial answer before crash');
  });

  it('returns null when shim has no runHeadless implementation', async () => {
    const handle = makeFakeShim({ events: [] });
    // Force-strip runHeadless to simulate a tmux-only shim
    delete (handle.shim as { runHeadless?: unknown }).runHeadless;
    const res = await callDoer(handle);
    expect(res).toBeNull();
  });
});
