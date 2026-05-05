import { execFileSync, spawn } from 'child_process';
import type { Command } from 'commander';
import fs from 'fs';
import open from 'open';
import os from 'os';
import path from 'path';
import {
  findPidsOnPort,
  isPortInUse,
  killAndVerify,
  pidLooksLikeChorus,
} from '../port-utils.js';
import { detectRuntimeEnv, shouldAutoOpenBrowser } from '../runtime-env.js';
import {
  COCKPIT_URL,
  DAEMON_URL,
  printCockpitAccessHint,
} from '../shared.js';
import { c, header, sym, tip } from '../ui.js';

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .option('--ui', 'Open browser UI after starting daemon')
    .description('Start the Chorus daemon (PM2-style fork)')
    .action(async (options: { ui?: boolean }) => {
      try {
        const chorusDir = path.join(os.homedir(), '.chorus');
        const pidFile = path.join(chorusDir, 'daemon.pid');

        if (await alreadyRunning(pidFile, options.ui)) return;
        if (await alreadyRunningOnDefaultPort(options.ui)) return;

        await reapOrphans();
        warnIfTmuxMissing();
        // Capture the interactive PATH from the user's terminal BEFORE
        // forking the daemon. The daemon's own spawn loses this — it
        // runs from a non-interactive shell that skips ~/.bashrc, so
        // tools installed to ~/.opencode/bin etc. would be missing.
        // Re-capturing on every start (not just init) means a user who
        // adds a new tool to PATH and restarts picks it up automatically.
        await captureAndPersistPath();
        spawnDaemonAndCockpit(chorusDir, pidFile);
        scheduleAutoOpenBrowser(options.ui);
      } catch (error) {
        console.error('Failed to start daemon:', error);
        process.exit(1);
      }
    });
}

/**
 * Run the user's interactive shell once and stash $PATH so the daemon
 * (running in a non-interactive shell that skips .bashrc/.zshrc) can
 * find CLIs the user installed via official curl-bash scripts.
 *
 * Best-effort. Capture or persist failures are swallowed — the daemon
 * has fallback known-install probes and the previous saved value, if
 * any, stays put.
 */
async function captureAndPersistPath(): Promise<void> {
  try {
    const { captureInteractivePath, persistCapturedPath } = await import(
      '../../lib/runtime-path.js'
    );
    const captured = captureInteractivePath();
    if (captured) await persistCapturedPath(captured);
  } catch {
    /* non-fatal */
  }
}

/**
 * Pidfile-less variant of `alreadyRunning`. Covers the case where
 * the daemon is healthy on :7707 but the pidfile is missing or stale
 * (manual deletion, /tmp wipe, prior crash before pidfile write,
 * sudo-started daemon vs. user-invoked `chorus start`, etc.).
 *
 * Without this, a healthy chorus + missing pidfile would fall through
 * to reapOrphans() and either kill the live daemon or hit the
 * "couldn't identify the PID" dead-end (when the daemon runs as a
 * different user and `ss -p` redacts the PID).
 *
 * The HTTP probe alone is a strong signal — chorus's /api/v1/health
 * returns a versioned envelope no random other process happens to
 * mimic. The PID-cmdline cross-check is belt-and-braces: only treat
 * "already running" as authoritative when both agree it's chorus.
 */
async function alreadyRunningOnDefaultPort(
  uiFlag: boolean | undefined,
): Promise<boolean> {
  // Short timeout — we're trying to fail fast and fall through to reap
  // logic when the daemon is actually dead. 1.5s covers a slow loopback
  // round-trip on resource-starved CI runners without making a healthy
  // system feel sluggish.
  let healthyVersion: string | null = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(`${DAEMON_URL}/api/v1/health`, {
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const envelope = (await res.json()) as {
      ok?: boolean;
      data?: { version?: string };
    };
    if (envelope.ok !== true || !envelope.data?.version) return false;
    healthyVersion = envelope.data.version;
  } catch {
    // ECONNREFUSED / abort / parse error → not a healthy chorus on :7707.
    return false;
  }

  // Cross-check: the PID listening on :7707 must look like chorus.
  // Without this, a foreign service that happens to respond 200 on
  // /api/v1/health with a matching envelope shape could fool us into
  // sending the user to a wrong cockpit URL. Belt-and-braces.
  const pids = findPidsOnPort(7707);
  const looksLikeChorus = pids.some((pid) => pidLooksLikeChorus(pid).match);
  if (pids.length > 0 && !looksLikeChorus) return false;

  console.log('');
  console.log(
    header(sym.ok, 'Chorus is already running', `version ${healthyVersion}`),
  );
  printCockpitAccessHint();
  if (uiFlag && shouldAutoOpenBrowser(detectRuntimeEnv())) {
    open(COCKPIT_URL);
  }
  return true;
}

async function alreadyRunning(
  pidFile: string,
  uiFlag: boolean | undefined,
): Promise<boolean> {
  if (!fs.existsSync(pidFile)) return false;
  const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
  try {
    // Cross-platform liveness probe. process.kill(pid, 0) throws if no
    // process with that pid exists; works on Windows/macOS/Linux unlike
    // the unix-only `kill -0` shell command we used to invoke here.
    if (Number.isFinite(oldPid) && oldPid > 0) {
      process.kill(oldPid, 0);
    } else {
      throw new Error('invalid pid');
    }
    console.log('');
    console.log(header(sym.ok, 'Chorus is already running', `daemon PID ${oldPid}`));
    printCockpitAccessHint();
    if (uiFlag && shouldAutoOpenBrowser(detectRuntimeEnv())) {
      open(COCKPIT_URL);
    }
    return true;
  } catch {
    // Process doesn't exist, clean up the stale pidfile.
    fs.unlinkSync(pidFile);
    return false;
  }
}

/**
 * Pre-spawn orphan reap. Pidfile-based liveness only catches the
 * recorded daemon PID — it misses a stale next-server (cockpit) or
 * daemon that survived a previous `chorus stop` because the SIGTERM
 * was ignored or the pidfile got out of sync. Without this sweep, a
 * fresh `chorus start` would race against the orphan on :5050 / :7707,
 * the new spawn would lose, and the user would see 500s served by the
 * ghost (incident 2026-05-03).
 *
 * Foreign-process guard: only reap PIDs whose cmdline looks like a
 * chorus daemon/cockpit. If something else (Grafana on :5050, a
 * colleague's `next dev` on :7707) is bound, refuse to kill it and ask
 * the user to free the port. Pre-fix the reaper would silently SIGKILL
 * whatever it found.
 */
async function reapOrphans(): Promise<void> {
  for (const [port, label] of [
    [7707, 'daemon'],
    [5050, 'cockpit'],
  ] as const) {
    if (!(await isPortInUse(port))) continue;
    const pids = findPidsOnPort(port);
    if (pids.length === 0) {
      console.log('');
      console.log(
        header(
          sym.err,
          `Port :${port} is in use by another process`,
          `couldn't identify the PID — free the port and retry`,
        ),
      );
      console.log('');
      process.exit(1);
    }
    for (const pid of pids) {
      const { match, cmdline } = pidLooksLikeChorus(pid);
      if (!match) {
        console.log('');
        console.log(
          header(
            sym.err,
            `Port :${port} is in use by a non-chorus process`,
            `PID ${pid}: ${cmdline ?? '(unreadable)'}`,
          ),
        );
        console.log('');
        console.log(
          tip(
            label === 'daemon'
              ? `Free :${port} (stop the other process, or relocate the daemon via CHORUS_DAEMON_PORT) and retry \`chorus start\`.`
              : `Free :${port} (stop the other process listening on the cockpit port) and retry \`chorus start\`.`,
          ),
        );
        console.log('');
        process.exit(1);
      }
      const dead = await killAndVerify(pid, `${label} orphan`);
      if (dead) {
        console.log(
          `  ${sym.ok} reaped ${label} orphan on :${port} ${c.dim(`(PID ${pid})`)}`,
        );
      }
    }
  }
}

/**
 * Default transport is 'headless' (no tmux needed). tmux is the
 * OPTIONAL backup mode for users who want to attach to a live voice
 * session and take over / watch step-by-step / hand off mid-run.
 * Surfaced once at start so power users know the feature exists.
 * Soft-info (not a warning) so we don't scare default-path users.
 */
function warnIfTmuxMissing(): void {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    console.log('');
    console.log(
      c.dim(
        `  ${sym.info} tmux not detected. Chorus runs headless by default — this is fine.`,
      ),
    );
    console.log(c.dim('    Optional backup mode: install tmux, then open'));
    console.log(
      c.dim(
        '    http://127.0.0.1:5050/settings#transport and pick "Tmux — attach & take over".',
      ),
    );
    console.log(
      c.dim(
        '    `tmux attach -t <name>` lets you watch step-by-step or take over mid-run.',
      ),
    );
    console.log(
      c.dim(
        '    macOS: brew install tmux · Ubuntu/Debian: apt install tmux · Fedora: dnf install tmux',
      ),
    );
    console.log('');
  }
}

function spawnDaemonAndCockpit(chorusDir: string, pidFile: string): void {
  // Prefer the compiled JS so a global install works (no src/ shipped,
  // no tsx loader registered); fall back to the .ts source when running
  // in dev mode where the user only has src/ on disk.
  const daemonJs = path.resolve(__dirname, '..', '..', 'daemon', 'index.js');
  const daemonTs = path.resolve(__dirname, '..', '..', '..', 'src', 'daemon', 'index.ts');
  const useCompiled = fs.existsSync(daemonJs);
  const daemonPath = useCompiled ? daemonJs : daemonTs;
  const spawnArgs = useCompiled ? [daemonPath] : ['-r', 'tsx/cjs', daemonPath];

  // Pipe daemon stdout + stderr to a log file so the user (and we, when
  // debugging) can see why a chat went sideways. Previously stdio was
  // 'ignore' which made silent failures impossible to diagnose. Logs
  // rotate manually; truncated to 10 MB max via periodic rotate inside
  // the daemon (TODO).
  fs.mkdirSync(chorusDir, { recursive: true });
  const logsDir = path.join(chorusDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const daemonLogPath = path.join(logsDir, 'daemon.log');
  const daemonLogFd = fs.openSync(daemonLogPath, 'a');

  const child = spawn('node', spawnArgs, {
    detached: true,
    stdio: ['ignore', daemonLogFd, daemonLogFd],
  });

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  fs.writeFileSync(pidFile, child.pid.toString());

  // Spawn the cockpit web UI alongside the daemon. The package ships a
  // built .next directory; run next from the package root so it picks
  // up the bundled bun_modules. Web PID is tracked separately so
  // `chorus stop` can clean up both.
  const packageRoot = path.resolve(__dirname, '..', '..', '..');
  const nextEntry = path.resolve(
    packageRoot,
    'node_modules',
    'next',
    'dist',
    'bin',
    'next',
  );
  const webPidFile = path.join(chorusDir, 'web.pid');
  if (
    fs.existsSync(nextEntry) &&
    fs.existsSync(path.join(packageRoot, '.next'))
  ) {
    const webLogPath = path.join(logsDir, 'web.log');
    const webLogFd = fs.openSync(webLogPath, 'a');
    const webChild = spawn(
      'node',
      [nextEntry, 'start', '-p', '5050', '-H', '127.0.0.1'],
      {
        cwd: packageRoot,
        detached: true,
        stdio: ['ignore', webLogFd, webLogFd],
      },
    );
    if (webChild.pid) {
      fs.writeFileSync(webPidFile, webChild.pid.toString());
      webChild.unref();
    }
  } else {
    // Loud, actionable error — the previous yellow warning was easy to
    // miss and left users at a blank cockpit URL with no idea why. We
    // keep the daemon running (MCP + API still work) but make the
    // remediation steps obvious.
    console.log('');
    console.log(c.red('  ✗ Cockpit UI not found.'));
    if (fs.existsSync(path.join(packageRoot, 'src'))) {
      console.log(c.dim('    This looks like a dev checkout. Build it once:'));
      console.log(`    ${c.bold('pnpm install && pnpm build')}`);
    } else {
      console.log(
        c.dim('    The published install should ship a built UI. Try reinstalling:'),
      );
      console.log(`    ${c.bold('npm install -g chorus-codes')}`);
    }
    console.log(
      c.dim('    The daemon API is still up on port 7707 if you only need MCP.'),
    );
    console.log('');
  }

  child.unref();

  console.log('');
  console.log(header(sym.ok, 'Chorus started', `daemon PID ${child.pid}`));
  printCockpitAccessHint();
}

function scheduleAutoOpenBrowser(uiFlag: boolean | undefined): void {
  setTimeout(() => {
    if (uiFlag && shouldAutoOpenBrowser(detectRuntimeEnv())) {
      open(COCKPIT_URL);
    }
  }, 1000);
}
