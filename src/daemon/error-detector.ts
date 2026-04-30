/**
 * CLI Failure Detector
 *
 * Pattern-matches tmux pane snapshots to detect known failure modes from
 * codex/claude/gemini/opencode CLIs. Returns structured CliError events
 * the runner emits as `cli_error` SSE messages.
 *
 * Observed patterns documented in:
 * /home/ubuntu/.claude/projects/-home-ubuntu/memory/chorus_cli_failure_modes.md
 * /home/ubuntu/.claude/projects/-home-ubuntu/memory/feedback_opencode_session_db_corruption.md
 */

export type CliErrorKind =
  | 'quota_exhausted'        // codex: "You've hit your usage limit. ... try again at <time>."
  | 'token_refresh_lost'     // codex: "access token could not be refreshed because your refresh token was already used"
  | 'mcp_handshake_failed'   // codex: "failed: handshaking with MCP server failed"
  | 'opencode_db_corrupt'    // opencode: "Provider returned error" repeating with no successful response in last N seconds
  | 'kimi_permission_prompt' // kimi: "Allow this tool?" dialog (only if --afk flag missing or future kimi rev drops it)
  | 'cold_start_timeout'     // CLI never showed its prompt within cold_start_timeout_s
  | 'tmux_dead'              // session no longer exists per tmux has-session
  | 'unknown';               // catch-all

export interface CliError {
  kind: CliErrorKind;
  lineage: string;           // 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot'
  message: string;           // user-friendly one-liner for the run header
  cta?: string;              // recommended action (e.g. 'Re-authenticate codex')
  detail?: string;           // raw line that triggered the match
  resetAt?: number;          // ms-epoch when retry is plausible (quota only)
}

/**
 * Parse human-readable reset time like "Apr 30th, 2026 10:05 PM" to ms-epoch.
 * Returns undefined on parse failure (UI hides the timer in that case).
 */
function parseResetTime(humanTime?: string): number | undefined {
  if (!humanTime) return undefined;
  // Strip ordinal suffixes: "1st" → "1", "2nd" → "2", "3rd" → "3", "4th" → "4", etc.
  const cleaned = humanTime.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  const t = Date.parse(cleaned);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Per-session state for detecting opencode DB corruption.
 * Tracks error count and timing of last error + success.
 */
interface OpenCodeState {
  errCount: number;
  lastErrAt: number;
  lastSuccessAt: number;
}

/**
 * ErrorDetector — stateful pattern-matching for CLI failure modes.
 *
 * Patterns 1-3 (quota, token-refresh, MCP) are stateless — matched inline.
 * Pattern 4 (opencode DB corruption) is stateful — tracks error frequency.
 *
 * Per-session dedup: the runner polls capture-pane every ~2s, so the same
 * quota text sits in the buffer and would emit on every poll. We track the
 * last-emitted error kind per session and suppress repeats of the same kind
 * until a different kind (or no error) appears.
 */
export class ErrorDetector {
  private openCodeState = new Map<string, OpenCodeState>();
  private lastEmittedKind = new Map<string, CliErrorKind>();

  /**
   * Inspect a tmux pane snapshot for known failure patterns.
   * Returns a CliError if a pattern matched, null otherwise.
   *
   * For opencode_db_corrupt: tracks state internally. Call reset() when
   * the session is killed or restarted to clear per-session counters.
   */
  inspect(sessionName: string, lineage: string, paneText: string): CliError | null {
    const result = this.detect(sessionName, lineage, paneText);
    if (!result) return null;

    // Dedup: skip if we already emitted this exact kind for this session.
    // The user's experience: one quota error event per quota event, not 149.
    const lastKind = this.lastEmittedKind.get(sessionName);
    if (lastKind === result.kind) return null;
    this.lastEmittedKind.set(sessionName, result.kind);
    return result;
  }

  /** Inner pattern matcher — see inspect() for the dedup wrapper. */
  private detect(sessionName: string, lineage: string, paneText: string): CliError | null {
    // Pattern 1: Codex quota exhausted
    if (lineage === 'openai') {
      const quotaMatch = /You've hit your usage limit\.[\s\S]*?try again at\s+([^\n.]+)/i.exec(paneText);
      if (quotaMatch) {
        const resetAtStr = quotaMatch[1];
        return {
          kind: 'quota_exhausted',
          lineage,
          message: resetAtStr
            ? `Codex quota exhausted. Resets ${resetAtStr.trim()}.`
            : 'Codex quota exhausted.',
          cta: 'Switch to a different codex account, or wait & retry.',
          resetAt: parseResetTime(resetAtStr),
          detail: quotaMatch[0],
        };
      }

      // Pattern 2: Codex token refresh lost
      if (/access token could not be refreshed/i.test(paneText)) {
        const match = /access token could not be refreshed[^\n]*/i.exec(paneText);
        return {
          kind: 'token_refresh_lost',
          lineage,
          message: 'Codex auth invalidated (token refresh race).',
          cta: 'Re-authenticate codex.',
          detail: match?.[0],
        };
      }

      // Pattern 3: Codex MCP handshake failed
      if (/handshaking with MCP server failed/i.test(paneText)) {
        const match = /handshaking with MCP server failed[^\n]*/i.exec(paneText);
        return {
          kind: 'mcp_handshake_failed',
          lineage,
          message: 'Codex MCP startup failed.',
          cta: 'Re-authenticate codex.',
          detail: match?.[0],
        };
      }
    }

    // Pattern 4: Opencode DB corruption (stateful)
    // Accept both 'opencode' (current) and 'xai' (legacy alias) lineage tags
    // so older templates / sessions don't silently lose detection.
    if (lineage === 'opencode' || lineage === 'xai') {
      return this.inspectOpenCodeCorruption(sessionName, paneText);
    }

    // Pattern 5: Kimi permission prompt (defense-in-depth fallback).
    // Normally kimi is launched with --afk which auto-approves; this catches
    // the case where a future kimi version drops --afk or shows a different
    // prompt type. Runner should auto-respond (send "always" + Enter) rather
    // than fail the chat.
    if (lineage === 'moonshot') {
      const promptMatch = /Allow .*tool|Approve .*call|Always allow|\[a\]llow/i.exec(paneText);
      if (promptMatch) {
        return {
          kind: 'kimi_permission_prompt',
          lineage,
          message: 'Kimi is asking to approve a tool call (--afk flag may have been ignored).',
          cta: 'Runner will auto-respond with "always allow".',
          detail: promptMatch[0],
        };
      }
    }

    return null;
  }

  /**
   * Stateful opencode detector: tracks "Provider returned error" frequency.
   *
   * Rules:
   * - Increment errCount if "Provider returned error" appears
   * - Reset errCount to 0 if we see "## DONE" (successful completion)
   * - Trigger opencode_db_corrupt when errCount >= 3 AND no success in last 60s
   */
  private inspectOpenCodeCorruption(sessionName: string, paneText: string): CliError | null {
    // Initialize state if first call for this session
    let state = this.openCodeState.get(sessionName);
    if (!state) {
      state = { errCount: 0, lastErrAt: 0, lastSuccessAt: Date.now() };
      this.openCodeState.set(sessionName, state);
    }

    const now = Date.now();

    // Check for successful completion sentinel
    if (/## DONE\b/i.test(paneText)) {
      state.errCount = 0;
      state.lastSuccessAt = now;
      return null;
    }

    // Count "Provider returned error" occurrences in this snapshot
    const errorMatches = paneText.match(/Provider returned error/gi);
    if (errorMatches) {
      state.errCount += errorMatches.length;
      state.lastErrAt = now;
    }

    // Trigger corruption error when:
    // - errCount >= 3 (multiple repeated errors)
    // - AND last success was >60 seconds ago (sustained failure, not transient)
    if (state.errCount >= 3 && now - state.lastSuccessAt > 60000) {
      return {
        kind: 'opencode_db_corrupt',
        lineage: 'opencode',
        message: 'Opencode session DB likely corrupted (Kimi rejecting empty msgs).',
        cta: 'Run `work-fleet-restart kimi deepseek` after wiping ~/.local/share/opencode/opencode.db',
        detail: 'Multiple Provider-returned-error responses in window.',
      };
    }

    return null;
  }

  /**
   * Reset per-session state (call when a session is killed or restarted).
   * Clears the error counter so a fresh retry doesn't auto-trigger on old errors.
   */
  reset(sessionName: string): void {
    this.openCodeState.delete(sessionName);
    this.lastEmittedKind.delete(sessionName);
  }

  /**
   * Periodic cleanup of stale state. Removes sessions idle >maxIdleMs.
   * Call every 5 minutes from the reaper.
   */
  cleanup(maxIdleMs: number): void {
    const now = Date.now();
    for (const [sessionName, state] of this.openCodeState.entries()) {
      const lastActivity = Math.max(state.lastErrAt, state.lastSuccessAt);
      if (now - lastActivity > maxIdleMs) {
        this.openCodeState.delete(sessionName);
      }
    }
  }
}

// ============================================================================
// Inline Tests (run with: node --import tsx --test)
// ============================================================================

// Simple assertion helper for Node's built-in test module
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// Helper to access private state for testing (via type assertion with string key)
function getOpenCodeState(detector: ErrorDetector): Map<string, OpenCodeState> {
  return ((detector as unknown) as Record<string, unknown>).openCodeState as Map<string, OpenCodeState>;
}

// Test suite
export function runTests(): void {
  const detector = new ErrorDetector();

  // ---- Test 1: Quota Exhausted ----
  {
    const paneText = "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Apr 30th, 2026 10:05 PM.";
    const error = detector.inspect('test-session-1', 'openai', paneText);
    assert(error !== null, 'Test 1: Expected error object');
    assertEquals(error!.kind, 'quota_exhausted', 'Test 1: kind should be quota_exhausted');
    assertEquals(error!.lineage, 'openai', 'Test 1: lineage should be openai');
    assert(error!.message.includes('Resets'), 'Test 1: message should include reset time');
    assert(error!.resetAt !== undefined, 'Test 1: resetAt should be parsed');
    assert(Number.isFinite(error!.resetAt!), 'Test 1: resetAt should be a valid number');
    console.log('✓ Test 1 (quota_exhausted): PASS');
  }

  // ---- Test 2: Token Refresh Lost ----
  {
    const paneText = "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    const error = detector.inspect('test-session-2', 'openai', paneText);
    assert(error !== null, 'Test 2: Expected error object');
    assertEquals(error!.kind, 'token_refresh_lost', 'Test 2: kind should be token_refresh_lost');
    assertEquals(error!.lineage, 'openai', 'Test 2: lineage should be openai');
    assert(!!error!.cta && error!.cta.includes('Re-authenticate'), 'Test 2: CTA should mention re-auth');
    console.log('✓ Test 2 (token_refresh_lost): PASS');
  }

  // ---- Test 3: MCP Handshake Failed ----
  {
    const paneText = "failed: handshaking with MCP server failed: Send message error Transport ... Your authentication token has been invalidated";
    const error = detector.inspect('test-session-3', 'openai', paneText);
    assert(error !== null, 'Test 3: Expected error object');
    assertEquals(error!.kind, 'mcp_handshake_failed', 'Test 3: kind should be mcp_handshake_failed');
    assertEquals(error!.lineage, 'openai', 'Test 3: lineage should be openai');
    assert(!!error!.cta && error!.cta.includes('Re-authenticate'), 'Test 3: CTA should mention re-auth');
    console.log('✓ Test 3 (mcp_handshake_failed): PASS');
  }

  // ---- Test 4a: Opencode DB Corrupt (3 errors, sustained) ----
  {
    const detector4a = new ErrorDetector();
    // Simulate 3 separate inspect calls, each with "Provider returned error"
    // and last success >60s ago
    const now = Date.now();

    // First error at now - 70s
    const state1 = getOpenCodeState(detector4a);
    state1.set('test-session-4a', {
      errCount: 0,
      lastErrAt: now - 70000,
      lastSuccessAt: now - 70000,
    });

    // Call inspect 3 times with errors
    const err1 = detector4a.inspect('test-session-4a', 'opencode', 'Provider returned error');
    assert(err1 === null, 'Test 4a.1: First error should not trigger yet');

    const err2 = detector4a.inspect('test-session-4a', 'opencode', 'Provider returned error');
    assert(err2 === null, 'Test 4a.2: Second error should not trigger yet');

    const err3 = detector4a.inspect('test-session-4a', 'opencode', 'Provider returned error');
    assert(err3 !== null, 'Test 4a.3: Third error with sustained failure should trigger');
    assertEquals(err3!.kind, 'opencode_db_corrupt', 'Test 4a: kind should be opencode_db_corrupt');
    console.log('✓ Test 4a (opencode_db_corrupt - sustained): PASS');
  }

  // ---- Test 4b: Opencode DB OK (error then success) ----
  {
    const detector4b = new ErrorDetector();
    // Send error, then success sentinel, then another error → should NOT trigger
    detector4b.inspect('test-session-4b', 'opencode', 'Provider returned error');
    detector4b.inspect('test-session-4b', 'opencode', 'Provider returned error');
    detector4b.inspect('test-session-4b', 'opencode', '## DONE'); // Reset errCount
    const err = detector4b.inspect('test-session-4b', 'opencode', 'Provider returned error');
    assert(err === null, 'Test 4b: Error after success sentinel should not trigger');
    console.log('✓ Test 4b (opencode_db_corrupt - transient): PASS');
  }

  // ---- Test 5: Reset clears state ----
  {
    const detector5 = new ErrorDetector();
    const state5 = getOpenCodeState(detector5);
    state5.set('test-session-5', { errCount: 10, lastErrAt: Date.now(), lastSuccessAt: Date.now() - 100000 });
    detector5.reset('test-session-5');
    assert(!state5.has('test-session-5'), 'Test 5: reset() should remove session state');
    console.log('✓ Test 5 (reset): PASS');
  }

  // ---- Test 6: Cleanup removes stale state ----
  {
    const detector6 = new ErrorDetector();
    const state6 = getOpenCodeState(detector6);
    const now = Date.now();
    state6.set('stale-session', {
      errCount: 1,
      lastErrAt: now - 600000, // 10 minutes ago
      lastSuccessAt: now - 600000,
    });
    state6.set('fresh-session', {
      errCount: 1,
      lastErrAt: now - 10000, // 10 seconds ago
      lastSuccessAt: now - 10000,
    });
    detector6.cleanup(300000); // 5 minute cleanup window
    assert(!state6.has('stale-session'), 'Test 6: cleanup should remove sessions idle >5min');
    assert(state6.has('fresh-session'), 'Test 6: cleanup should keep recent sessions');
    console.log('✓ Test 6 (cleanup): PASS');
  }

  // ---- Test 7: Non-matching lineages return null ----
  {
    const paneText = "Some random output";
    const error = detector.inspect('test-session-7', 'anthropic', paneText);
    assert(error === null, 'Test 7: Non-matching lineage should return null');
    console.log('✓ Test 7 (non-matching lineage): PASS');
  }

  // ---- Test 8: Parse reset time handles ordinals ----
  {
    const times = [
      { input: 'Apr 30th, 2026 10:05 PM', shouldParse: true },
      { input: 'May 1st, 2026 3:15 AM', shouldParse: true },
      { input: 'June 22nd, 2026 11:59 PM', shouldParse: true },
      { input: 'July 3rd, 2026 12:00 AM', shouldParse: true },
    ];
    for (const { input, shouldParse } of times) {
      const result = parseResetTime(input);
      if (shouldParse) {
        assert(result !== undefined, `Test 8: parseResetTime("${input}") should parse`);
        assert(Number.isFinite(result!), `Test 8: parseResetTime("${input}") should be finite`);
      }
    }
    console.log('✓ Test 8 (parseResetTime ordinals): PASS');
  }

  console.log('\n✅ All tests passed!');
}

// Run tests if this file is executed directly (CommonJS-compatible check).
// (When the daemon is bundled to CommonJS for production, `import.meta` isn't
// available; this guard works in both dev tsx-loader and prod cjs builds.)
declare const require: { main?: NodeModule } | undefined;
declare const module: NodeModule | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runTests();
}
