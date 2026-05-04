/**
 * Vitest equivalents of the previous inline `runTests` self-checks in
 * src/daemon/error-detector.ts. Same fixtures, same assertions; lifted
 * into a proper test harness as part of the public-review cleanup pass.
 */
import { describe, expect, it } from 'vitest';
import { ErrorDetector } from '../src/daemon/error-detector.js';

interface OpenCodeState {
  errCount: number;
  lastErrAt: number;
  lastSuccessAt: number;
}

function getOpenCodeState(detector: ErrorDetector): Map<string, OpenCodeState> {
  return (detector as unknown as { openCodeState: Map<string, OpenCodeState> })
    .openCodeState;
}

describe('ErrorDetector.inspect — quota_exhausted (codex)', () => {
  it('parses Codex quota text and returns a quota_exhausted error', () => {
    const detector = new ErrorDetector();
    const paneText =
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Apr 30th, 2026 10:05 PM.";
    const error = detector.inspect('test-session-1', 'openai', paneText);
    expect(error).not.toBeNull();
    expect(error!.kind).toBe('quota_exhausted');
    expect(error!.lineage).toBe('openai');
    expect(error!.message).toContain('Resets');
    expect(error!.resetAt).toBeDefined();
    expect(Number.isFinite(error!.resetAt!)).toBe(true);
  });
});

describe('ErrorDetector.inspect — token_refresh_lost (codex)', () => {
  it('flags token-refresh failures with a re-authenticate CTA', () => {
    const detector = new ErrorDetector();
    const paneText =
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
    const error = detector.inspect('test-session-2', 'openai', paneText);
    expect(error).not.toBeNull();
    expect(error!.kind).toBe('token_refresh_lost');
    expect(error!.lineage).toBe('openai');
    expect(error!.cta ?? '').toContain('Re-authenticate');
  });
});

describe('ErrorDetector.inspect — mcp_handshake_failed (codex)', () => {
  it('flags MCP handshake failures with a re-authenticate CTA', () => {
    const detector = new ErrorDetector();
    const paneText =
      'failed: handshaking with MCP server failed: Send message error Transport ... Your authentication token has been invalidated';
    const error = detector.inspect('test-session-3', 'openai', paneText);
    expect(error).not.toBeNull();
    expect(error!.kind).toBe('mcp_handshake_failed');
    expect(error!.lineage).toBe('openai');
    expect(error!.cta ?? '').toContain('Re-authenticate');
  });
});

describe('ErrorDetector.inspect — opencode_db_corrupt', () => {
  it('triggers after 3 sustained "Provider returned error" hits', () => {
    const detector = new ErrorDetector();
    const now = Date.now();
    const state = getOpenCodeState(detector);
    state.set('test-session-4a', {
      errCount: 0,
      lastErrAt: now - 70000,
      lastSuccessAt: now - 70000,
    });

    expect(
      detector.inspect('test-session-4a', 'opencode', 'Provider returned error'),
    ).toBeNull();
    expect(
      detector.inspect('test-session-4a', 'opencode', 'Provider returned error'),
    ).toBeNull();
    const third = detector.inspect(
      'test-session-4a',
      'opencode',
      'Provider returned error',
    );
    expect(third).not.toBeNull();
    expect(third!.kind).toBe('opencode_db_corrupt');
  });

  it('does NOT trigger when an interleaved success sentinel resets the counter', () => {
    const detector = new ErrorDetector();
    detector.inspect('test-session-4b', 'opencode', 'Provider returned error');
    detector.inspect('test-session-4b', 'opencode', 'Provider returned error');
    detector.inspect('test-session-4b', 'opencode', '## DONE');
    const err = detector.inspect(
      'test-session-4b',
      'opencode',
      'Provider returned error',
    );
    expect(err).toBeNull();
  });
});

describe('ErrorDetector.reset', () => {
  it('removes per-session state', () => {
    const detector = new ErrorDetector();
    const state = getOpenCodeState(detector);
    state.set('test-session-5', {
      errCount: 10,
      lastErrAt: Date.now(),
      lastSuccessAt: Date.now() - 100000,
    });
    detector.reset('test-session-5');
    expect(state.has('test-session-5')).toBe(false);
  });
});

describe('ErrorDetector.cleanup', () => {
  it('removes sessions idle longer than the cutoff and keeps fresh ones', () => {
    const detector = new ErrorDetector();
    const state = getOpenCodeState(detector);
    const now = Date.now();
    state.set('stale-session', {
      errCount: 1,
      lastErrAt: now - 600000,
      lastSuccessAt: now - 600000,
    });
    state.set('fresh-session', {
      errCount: 1,
      lastErrAt: now - 10000,
      lastSuccessAt: now - 10000,
    });
    detector.cleanup(300000);
    expect(state.has('stale-session')).toBe(false);
    expect(state.has('fresh-session')).toBe(true);
  });
});

describe('ErrorDetector.inspect — non-matching lineages', () => {
  it('returns null for lineages that have no detectors', () => {
    const detector = new ErrorDetector();
    const error = detector.inspect('test-session-7', 'anthropic', 'Some random output');
    expect(error).toBeNull();
  });
});

describe('Codex quota reset-time parsing (via inspect)', () => {
  it.each([
    'Apr 30th, 2026 10:05 PM',
    'May 1st, 2026 3:15 AM',
    'June 22nd, 2026 11:59 PM',
    'July 3rd, 2026 12:00 AM',
  ])('parses ordinal-date "%s" into a finite resetAt', (resetText) => {
    const detector = new ErrorDetector();
    const paneText = `You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at ${resetText}.`;
    const error = detector.inspect('rt-' + resetText, 'openai', paneText);
    expect(error).not.toBeNull();
    expect(error!.resetAt).toBeDefined();
    expect(Number.isFinite(error!.resetAt!)).toBe(true);
  });
});
