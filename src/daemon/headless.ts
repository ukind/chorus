/**
 * Headless transport — spawn helpers, timeout/abort enforcement, heartbeat,
 * and orphan cleanup. Used by every shim's `runHeadless` implementation.
 *
 * Why this module exists:
 *   - tmux holds a TUI process resident (~200-500MB per CLI). 3 reviewers in
 *     parallel = 1-1.5GB just sitting there. Headless drops that to zero
 *     between rounds (process spawns, runs, exits).
 *   - Pane-scraping regex is fragile. Stream-json events are structured.
 *   - Permission dialogs mostly disappear in headless mode (CLIs auto-approve).
 *
 * Stuck-process safety (CRITICAL):
 *   - Every spawn enforces `timeoutMs` (default 10min) — SIGTERM on timeout,
 *     SIGKILL after 5s grace.
 *   - AbortSignal does the same kill sequence.
 *   - Daemon-startup reaper sweeps for orphan PIDs from prior runs (chats
 *     marked drafting/reviewing whose subprocesses outlived a daemon restart).
 *   - Without these, a hung CLI burns paid API tokens forever.
 */

import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from './agents/types.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_MS = 5_000;               // SIGKILL after SIGTERM + 5s
const HEARTBEAT_INTERVAL_MS = 5_000;       // progress event for non-streaming CLIs

/**
 * Where we persist child PIDs across daemon restarts so the reaper can find
 * orphans. One file per spawn, deleted on clean exit.
 */
const PID_DIR = path.join(os.homedir(), '.chorus', 'pids');

function ensurePidDir(): void {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });
}

function pidFilePath(pid: number): string {
  return path.join(PID_DIR, `${pid}.json`);
}

interface PidRecord {
  pid: number;
  cli: string;
  chatId?: string;
  startedAt: number;
  cwd: string;
}

/**
 * Register a child PID on disk so the reaper can clean it up if the daemon
 * crashes. Called from spawn helpers below; matched by `unregisterPid` on
 * clean exit.
 */
function registerPid(rec: PidRecord): void {
  ensurePidDir();
  try {
    fs.writeFileSync(pidFilePath(rec.pid), JSON.stringify(rec), 'utf-8');
  } catch {
    // Best-effort — failing to register doesn't block the spawn.
  }
}

function unregisterPid(pid: number): void {
  try {
    fs.unlinkSync(pidFilePath(pid));
  } catch {
    // Already gone, fine.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon-startup reaper. Walks PID_DIR, kills any process that's still alive
 * (orphan from a prior daemon crash), and clears the records.
 *
 * Call once from the daemon's bootstrap before accepting requests. Without
 * this, a daemon crash mid-run leaves child CLIs alive — they'll keep
 * burning subscription quota or API tokens until manually killed.
 */
export function reapOrphanProcesses(): { reaped: number; cleared: number } {
  if (!fs.existsSync(PID_DIR)) return { reaped: 0, cleared: 0 };
  let reaped = 0;
  let cleared = 0;
  for (const entry of fs.readdirSync(PID_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const recordPath = path.join(PID_DIR, entry);
    try {
      const rec = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as PidRecord;
      // Check if the process is still alive.
      if (processIsAlive(rec.pid)) {
        // Still alive — orphan. Send SIGTERM.
        try {
          process.kill(rec.pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
        // Schedule SIGKILL after grace; use unref so it doesn't block exit.
        const t = setTimeout(() => {
          try {
            process.kill(rec.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
        t.unref();
        reaped++;
        // IMPORTANT: Do not unlink the record yet. If daemon crashes during
        // the grace period, the PID record stays on disk for next startup.
        // The next reaper run will find it and try again.
      } else {
        // Process already dead — safe to clear the record.
        cleared++;
        try {
          fs.unlinkSync(recordPath);
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Malformed record — drop it.
      try {
        fs.unlinkSync(recordPath);
      } catch {
        /* ignore */
      }
    }
  }
  return { reaped, cleared };
}

/**
 * Result handle from `spawnHeadless`. Holds the process for cancellation and
 * an async iterator of AgentEvents the caller consumes.
 */
export interface HeadlessRun {
  pid: number;
  events: AsyncIterable<AgentEvent>;
  /** Resolves when the child exits (clean or killed). */
  done: Promise<{ code: number | null; killed: boolean; reason?: string }>;
}

export interface SpawnHeadlessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** If set, written to stdin then stdin closed. */
  stdinPayload?: string;
  /** Environment overrides (merged with process.env). */
  env?: Record<string, string>;
  /** Hard timeout. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** External cancel signal (chat cancelled, daemon shutdown). */
  abortSignal?: AbortSignal;
  /**
   * Stream parser: take a line of stdout, return zero-or-more AgentEvents.
   * Called once per `\n`-terminated line. Buffer split is handled here.
   *
   * Streaming CLIs (Claude, Gemini, Kimi) parse stream-json into deltas.
   * One-shot CLIs (OpenCode, Codex) accumulate text and return it all on
   * the synthetic `message_done` we emit at exit.
   */
  parseLine: (line: string) => AgentEvent[];
  /**
   * Called at process exit with the full accumulated stdout. Used for
   * one-shot CLIs to emit a final `message_done` from the entire blob.
   * Streaming CLIs typically return [] (their `message_done` came from
   * `parseLine` already).
   */
  onExit?: (fullStdout: string, fullStderr: string, code: number | null) => AgentEvent[];
  /**
   * If true, emit a `progress` event every HEARTBEAT_INTERVAL_MS while the
   * process is alive. Use for one-shot CLIs that don't stream. Default false.
   */
  heartbeat?: boolean;
  /** Tag for the PID record (CLI name, chatId). Best-effort logging only. */
  cli: string;
  chatId?: string;
}

/**
 * Spawn a headless CLI subprocess and yield AgentEvents from its stdout.
 *
 * Lifecycle:
 *   1. Spawn child + register PID for orphan reaper
 *   2. Pipe stdinPayload (if any), close stdin
 *   3. Stream stdout line-by-line through parseLine → events queue
 *   4. Emit progress heartbeats if enabled
 *   5. On exit: emit onExit(fullStdout) events, then close iterator
 *   6. On abort/timeout: SIGTERM, then SIGKILL after KILL_GRACE_MS
 *   7. unregister PID on any exit path
 */
export function spawnHeadless(opts: SpawnHeadlessOptions): HeadlessRun {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const child: ChildProcessWithoutNullStreams = spawnChild(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (child.pid !== undefined) {
    registerPid({
      pid: child.pid,
      cli: opts.cli,
      chatId: opts.chatId,
      startedAt,
      cwd: opts.cwd,
    });
  } else {
    console.warn(`[headless] spawn succeeded but child.pid is undefined (cli=${opts.cli})`);
  }

  // Buffer of pending events for the async iterator. We push from stdout
  // listener / heartbeat / exit; the iterator's `next()` drains.
  const queue: AgentEvent[] = [];
  let queueResolver: ((value: void) => void) | null = null;
  let closed = false;

  const enqueue = (e: AgentEvent): void => {
    queue.push(e);
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  };

  const closeQueue = (): void => {
    closed = true;
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  };

  // ─── stdin payload ─────────────────────────────────────────────────────
  if (opts.stdinPayload !== undefined) {
    try {
      child.stdin.write(opts.stdinPayload);
      child.stdin.end();
    } catch {
      // child may have died before stdin pipe ready
    }
  } else {
    // Always close stdin to unblock CLIs that block on EOF
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  }

  // ─── stdout / stderr accumulators ──────────────────────────────────────
  //
  // fullStdout + fullStderr buffer the entire CLI output for `onExit` callers
  // (codex/opencode emit one final blob, parsed at exit) and for the tail
  // diagnostic on hangs (lines 391–392 below). A pathological CLI streaming
  // unparsed output forever would otherwise grow these strings unbounded
  // until the daemon OOMs. Cap each at MAX_FULL_BUFFER_BYTES; once exceeded
  // we keep accumulating *for parsing* via stdoutBuf (line-mode), but stop
  // appending to the full-text accumulator and set a truncation flag the
  // exit path surfaces in error events.
  const MAX_FULL_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
  let stdoutBuf = '';
  let fullStdout = '';
  let stdoutTruncated = false;
  let fullStderr = '';
  let stderrTruncated = false;

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    if (!stdoutTruncated) {
      if (Buffer.byteLength(fullStdout, 'utf-8') + Buffer.byteLength(chunk, 'utf-8') > MAX_FULL_BUFFER_BYTES) {
        stdoutTruncated = true;
      } else {
        fullStdout += chunk;
      }
    }
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      try {
        for (const evt of opts.parseLine(line)) enqueue(evt);
      } catch (err) {
        enqueue({
          type: 'error',
          kind: 'parse_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // ─── stderr (for error visibility, not parsing) ────────────────────────
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    if (stderrTruncated) return;
    if (Buffer.byteLength(fullStderr, 'utf-8') + Buffer.byteLength(chunk, 'utf-8') > MAX_FULL_BUFFER_BYTES) {
      stderrTruncated = true;
      return;
    }
    fullStderr += chunk;
  });

  // ─── heartbeat ─────────────────────────────────────────────────────────
  let heartbeatHandle: NodeJS.Timeout | null = null;
  if (opts.heartbeat) {
    heartbeatHandle = setInterval(() => {
      if (closed) return;
      enqueue({ type: 'progress', elapsedMs: Date.now() - startedAt });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatHandle.unref();
  }

  // ─── timeout + abort kill plumbing ─────────────────────────────────────
  let killReason: string | undefined;

  const sigtermThenKill = (reason: string): void => {
    if (killReason) return; // already killing
    killReason = reason;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, KILL_GRACE_MS);
    t.unref();
  };

  const timeoutHandle = setTimeout(() => {
    sigtermThenKill('timeout');
  }, timeoutMs);
  timeoutHandle.unref();

  const abortHandler = (): void => sigtermThenKill('aborted');
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      sigtermThenKill('aborted');
    } else {
      opts.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // ─── exit ─────────────────────────────────────────────────────────────
  const done = new Promise<{ code: number | null; killed: boolean; reason?: string }>(
    (resolve) => {
      child.on('exit', (code) => {
        clearTimeout(timeoutHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', abortHandler);
        }
        unregisterPid(child.pid ?? -1);

        // Drain any trailing partial line through parser one more time.
        if (stdoutBuf.length > 0) {
          try {
            for (const evt of opts.parseLine(stdoutBuf)) enqueue(evt);
          } catch {
            /* parse errors at EOF aren't fatal */
          }
          stdoutBuf = '';
        }

        // Per-shim final emission (e.g. message_done from full output for
        // one-shot CLIs). When the 10 MB accumulator cap was hit we MUST
        // surface a partial-output warning — non-streaming CLIs (codex,
        // opencode) feed fullStdout into onExit() to parse the final blob,
        // and a truncated blob would parse as "complete" silently. The
        // warning is independent of exit code: a "successful" run with a
        // truncated diagnostic is still incomplete from the user's view.
        if (stdoutTruncated || stderrTruncated) {
          enqueue({
            type: 'error',
            kind: 'output_truncated',
            message: `${opts.cli} output exceeded ${MAX_FULL_BUFFER_BYTES / (1024 * 1024)} MB cap; trailing data dropped. Final parse may be incomplete.`,
          });
        }
        if (opts.onExit) {
          try {
            for (const evt of opts.onExit(fullStdout, fullStderr, code)) enqueue(evt);
          } catch {
            /* ignore */
          }
        }

        if (killReason && code !== 0) {
          enqueue({
            type: 'error',
            kind: killReason,
            message: killReason === 'timeout'
              ? `CLI ${opts.cli} timed out after ${Math.round(timeoutMs / 1000)}s`
              : `CLI ${opts.cli} cancelled`,
          });
        } else if (code !== 0 && code !== null) {
          // Process exited non-zero on its own — likely auth/config/quota.
          // Surface BOTH stderr and stdout so the user sees an actionable
          // message instead of a silent 0-byte answer.md. Some CLIs print
          // their actual error to stdout (kimi: "LLM not set") and only
          // bookkeeping info to stderr ("To resume this session: ..."), so
          // checking both is non-optional. Trim to keep it terse.
          const stderrTail = fullStderr.trim().slice(-300);
          const stdoutTail = fullStdout.trim().slice(-300);
          const tails = [stdoutTail, stderrTail].filter((s) => s.length > 0).join(' | ');
          // If we hit the 10 MB accumulator cap, the *leading* output is
          // captured but the trailing part is dropped on the floor (we stop
          // appending early to avoid OOM). Surface a short note so the user
          // knows the diagnostic is partial; the full output, if needed, is
          // recoverable via the per-round artifact files in the chat dir.
          const truncationNote =
            stdoutTruncated || stderrTruncated
              ? `[output truncated at ${MAX_FULL_BUFFER_BYTES / (1024 * 1024)}MB cap]`
              : '';
          const detail = [tails, truncationNote].filter((s) => s.length > 0).join(' ');
          enqueue({
            type: 'error',
            kind: 'cli_failed',
            message: detail.length > 0
              ? `${opts.cli} exited ${code}: ${detail}`
              : `${opts.cli} exited ${code} with no output`,
          });
        }

        closeQueue();
        resolve({ code, killed: Boolean(killReason), reason: killReason });
      });

      child.on('error', (err) => {
        enqueue({
          type: 'error',
          kind: 'spawn_failed',
          message: err.message,
        });
        // 'exit' will follow with code=null
      });
    },
  );

  // ─── async iterator ────────────────────────────────────────────────────
  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              queueResolver = resolve;
            });
          }
          if (queue.length > 0) {
            const value = queue.shift() as AgentEvent;
            return { value, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };

  return { pid: child.pid ?? -1, events, done };
}
