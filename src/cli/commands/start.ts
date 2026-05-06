import { execFileSync, spawn } from 'child_process';
import type { Command } from 'commander';
import fs from 'fs';
import open from 'open';
import os from 'os';
import path from 'path';
import {
  COCKPIT_PORT_RANGE,
  DAEMON_PORT_RANGE,
  DEFAULT_COCKPIT_PORT,
  DEFAULT_DAEMON_PORT,
  isPidAlive,
  pickFreePort,
  readLiveDaemonInfo,
  writeDaemonInfo,
} from '../../lib/daemon-discovery.js';
import {
  findPidsOnPort,
  findPidsOnPortWithSudo,
  isPortInUse,
  killAndVerify,
  killWithSudoAndVerify,
  pidLooksLikeChorus,
} from '../port-utils.js';
import { detectRuntimeEnv, shouldAutoOpenBrowser } from '../runtime-env.js';
import { pkg } from '../shared.js';
import { c, header, sym, tip } from '../ui.js';

interface PortPair {
  daemonPort: number;
  cockpitPort: number;
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .option('--ui', 'Open browser UI after starting daemon')
    .option('--daemon-only', 'Skip cockpit (Next.js UI). Used by MCP auto-start.')
    .description('Start the Chorus daemon (PM2-style fork)')
    .action(
      async (options: { ui?: boolean; daemonOnly?: boolean }) => {
        try {
          const chorusDir = path.join(os.homedir(), '.chorus');

          if (await alreadyRunningHealthy(options.ui)) return;

          // Concurrent-start guard. Two MCP shims hitting auto-start
          // simultaneously would otherwise both pickPortPair → spawn
          // a daemon → write daemon.json. Whichever writes second
          // overwrites the first, leaving an orphan listening on a
          // forgotten port. Using O_EXCL on the lockfile means the
          // loser fails fast and falls through to alreadyRunningHealthy
          // on retry (after the winner finishes spawning).
          const lockReleased = await acquireStartLock(chorusDir);
          if (!lockReleased) {
            // Another start is in flight. Poll briefly for daemon.json
            // to appear, then fall back to the already-running path.
            await waitForAnotherStartToWin();
            if (await alreadyRunningHealthy(options.ui)) return;
            // Otherwise: stale lock + no winner. Force-clear and retry.
            clearStartLock(chorusDir);
            if (!(await acquireStartLock(chorusDir))) {
              throw new Error(
                'Could not acquire start lock after fallback. Try `chorus stop` then retry.',
              );
            }
          }

          try {
            await reapOrphans();
            warnIfTmuxMissing();
            await captureAndPersistPath();

            const ports = await pickPortPair();
            await spawnDaemonAndCockpit(chorusDir, ports, {
              daemonOnly: options.daemonOnly === true,
            });
            scheduleAutoOpenBrowser(options.ui, ports.cockpitPort);
          } finally {
            releaseStartLock(chorusDir);
          }
        } catch (error) {
          console.error('Failed to start daemon:', error);
          process.exit(1);
        }
      },
    );
}

/**
 * Acquire ~/.chorus/start.lock with O_EXCL. Returns true on success;
 * false if another start has the lock. Stale-lock recovery is the
 * caller's responsibility.
 */
async function acquireStartLock(chorusDir: string): Promise<boolean> {
  fs.mkdirSync(chorusDir, { recursive: true });
  const lockPath = path.join(chorusDir, 'start.lock');
  try {
    // O_EXCL fails if file exists; combined with O_CREAT this is the
    // atomic check-and-create primitive Linux gives us. Write our PID
    // into it so a stale lock can be diagnosed.
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseStartLock(chorusDir: string): void {
  const lockPath = path.join(chorusDir, 'start.lock');
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function clearStartLock(chorusDir: string): void {
  releaseStartLock(chorusDir);
}

/**
 * The lock-loser polls for daemon.json to appear, then defers to
 * alreadyRunningHealthy. Bounded wait — the winner's spawn-and-record
 * flow takes ~5s on healthy machines.
 */
async function waitForAnotherStartToWin(): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const live = await readLiveDaemonInfo({ healthTimeoutMs: 500 });
    if (live) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Run the user's interactive shell once and stash $PATH so the daemon
 * (running in a non-interactive shell that skips .bashrc/.zshrc) can
 * find CLIs the user installed via official curl-bash scripts.
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
 * Detect a healthy chorus already running on this host before we try
 * to spawn another one. Replaces the v0.7 pidfile + default-port pair:
 * since v0.8 records both ports in daemon.json, a single source check
 * covers both "I started chorus 5 minutes ago and forgot" and "another
 * uid has chorus on a different port" cases.
 *
 * Cross-uid hardening: the daemon.json file itself is in $HOME, so we
 * only see *our* daemon. A sudo-started daemon's daemon.json lives in
 * root's $HOME and is invisible to the unprivileged probe. The orphan
 * reaper handles that case via cmdline + cwd matching.
 */
async function alreadyRunningHealthy(
  uiFlag: boolean | undefined,
): Promise<boolean> {
  // Use a longer health timeout here than at runtime resolution: WSL
  // loopback is slow on cold start (we observed 3-4s round-trips), and
  // we'd rather wait 5s once than mis-diagnose a healthy daemon as
  // dead and pile a second one on top of it.
  const live = await readLiveDaemonInfo({ healthTimeoutMs: 5000 });
  if (!live) return false;

  console.log('');
  console.log(
    header(sym.ok, 'Chorus is already running', `version ${live.version || pkg.version}`),
  );
  // Only point at the cockpit URL when a cockpit was actually started.
  // A `--daemon-only` start records cockpitPid=null; the cockpit port
  // itself is reserved but no Next.js process is bound to it.
  const cockpitRunning = live.cockpitPid !== null;
  if (cockpitRunning) {
    const cockpitUrl = `http://127.0.0.1:${live.cockpitPort}`;
    console.log('');
    console.log(`   ${c.gray('Open')}  ${c.cyan(cockpitUrl)}`);
    const env = detectRuntimeEnv();
    if (env.hint) {
      console.log('');
      console.log(tip(env.hint));
    }
    console.log('');
    if (uiFlag && shouldAutoOpenBrowser(env)) {
      open(cockpitUrl);
    }
  } else {
    console.log('');
    console.log(c.dim('   Daemon-only mode. Run `chorus start --ui` to bring up the cockpit.'));
    console.log('');
  }
  return true;
}

/**
 * Pick a free (daemon, cockpit) port pair. Honours CHORUS_DAEMON_PORT
 * and CHORUS_COCKPIT_PORT env overrides as the *preferred* starting
 * point — the walk still fires off them if taken. If the walk
 * exhausts, exit with the same actionable diagnostic the v0.7 reaper
 * used.
 */
async function pickPortPair(): Promise<PortPair> {
  const preferredDaemon = parseEnvPort('CHORUS_DAEMON_PORT', DEFAULT_DAEMON_PORT);
  const preferredCockpit = parseEnvPort('CHORUS_COCKPIT_PORT', DEFAULT_COCKPIT_PORT);

  const daemonPort = await pickFreePort(
    preferredDaemon,
    DAEMON_PORT_RANGE,
    isPortInUse,
  );
  if (daemonPort === null) {
    failPortWalk('daemon', preferredDaemon, DAEMON_PORT_RANGE);
  }
  const cockpitPort = await pickFreePort(
    preferredCockpit,
    COCKPIT_PORT_RANGE,
    isPortInUse,
  );
  if (cockpitPort === null) {
    failPortWalk('cockpit', preferredCockpit, COCKPIT_PORT_RANGE);
  }
  return { daemonPort: daemonPort!, cockpitPort: cockpitPort! };
}

function parseEnvPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

function failPortWalk(label: string, start: number, range: number): never {
  const end = start + range - 1;
  console.log('');
  console.log(
    header(
      sym.err,
      `No free ${label} port in range :${start}–:${end}`,
      'every candidate port is held by another process',
    ),
  );
  console.log('');
  console.log(c.dim('  Find what owns these ports:'));
  for (let p = start; p <= end; p += 1) {
    console.log(`    sudo lsof -iTCP:${p} -sTCP:LISTEN`);
  }
  console.log('');
  console.log(c.dim('  Or pick a different starting port:'));
  console.log(
    `    CHORUS_${label.toUpperCase()}_PORT=<port> chorus start`,
  );
  console.log('');
  process.exit(1);
}

/**
 * Pre-spawn orphan reap. Sweeps the *default* daemon + cockpit ports
 * because that's where v0.7 daemons would have bound — we want to
 * absorb stale v0.7 processes during the v0.8 transition. The picker
 * still walks past whatever survives, so the reap is best-effort
 * cleanup, not a prerequisite.
 *
 * Foreign-process guard: only reap PIDs whose cmdline looks like a
 * chorus daemon/cockpit. If something else is bound, refuse to kill
 * it and ask the user to free the port — same behaviour as v0.7.
 */
async function reapOrphans(): Promise<void> {
  for (const [port, label] of [
    [DEFAULT_DAEMON_PORT, 'daemon'],
    [DEFAULT_COCKPIT_PORT, 'cockpit'],
  ] as const) {
    if (!(await isPortInUse(port))) continue;

    let pids = findPidsOnPort(port);
    let needsSudoToKill = false;
    if (pids.length === 0) {
      pids = findPidsOnPortWithSudo(port);
      needsSudoToKill = pids.length > 0;
    }

    if (pids.length === 0) {
      // Couldn't see who owns the default port — the picker will walk
      // past it. Don't fail; just note it.
      console.log('');
      console.log(
        c.dim(
          `  ${sym.info} Port :${port} is in use but the owner isn't visible. Will pick the next free port.`,
        ),
      );
      continue;
    }

    for (const pid of pids) {
      const { match, cmdline } = pidLooksLikeChorus(pid);
      if (!match) {
        // Foreign process on the default port — let the picker walk
        // past it. Don't fail.
        console.log('');
        console.log(
          c.dim(
            `  ${sym.info} Port :${port} is held by ${cmdline ?? `PID ${pid}`} — will pick the next free port.`,
          ),
        );
        continue;
      }
      const dead = needsSudoToKill
        ? await killWithSudoAndVerify(pid, `${label} orphan`)
        : await killAndVerify(pid, `${label} orphan`);
      if (dead) {
        console.log(
          `  ${sym.ok} reaped ${label} orphan on :${port} ${c.dim(`(PID ${pid}${needsSudoToKill ? ', cross-uid via sudo' : ''})`)}`,
        );
      }
    }
  }
}

/**
 * Default transport is 'headless' (no tmux needed). tmux is the
 * OPTIONAL backup mode for users who want to attach to a live voice
 * session and take over / watch step-by-step / hand off mid-run.
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
        '    /settings#transport in the cockpit and pick "Tmux — attach & take over".',
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

async function spawnDaemonAndCockpit(
  chorusDir: string,
  ports: PortPair,
  options: { daemonOnly: boolean } = { daemonOnly: false },
): Promise<void> {
  const daemonJs = path.resolve(__dirname, '..', '..', 'daemon', 'index.js');
  const daemonTs = path.resolve(__dirname, '..', '..', '..', 'src', 'daemon', 'index.ts');
  const useCompiled = fs.existsSync(daemonJs);
  const daemonPath = useCompiled ? daemonJs : daemonTs;
  const spawnArgs = useCompiled ? [daemonPath] : ['-r', 'tsx/cjs', daemonPath];

  fs.mkdirSync(chorusDir, { recursive: true });
  const logsDir = path.join(chorusDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const daemonLogPath = path.join(logsDir, 'daemon.log');
  const daemonLogFd = fs.openSync(daemonLogPath, 'a');

  const child = spawn('node', spawnArgs, {
    detached: true,
    stdio: ['ignore', daemonLogFd, daemonLogFd],
    env: {
      ...process.env,
      CHORUS_DAEMON_PORT: String(ports.daemonPort),
      CHORUS_COCKPIT_PORT: String(ports.cockpitPort),
    },
  });

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  const pidFile = path.join(chorusDir, 'daemon.pid');
  fs.writeFileSync(pidFile, child.pid.toString());

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
  let cockpitPid: number | null = null;
  if (options.daemonOnly) {
    // Skip cockpit spawn — used by MCP auto-start where the user
    // hasn't asked for the UI. Daemon API alone is enough for the
    // editor to make tool calls.
  } else if (
    fs.existsSync(nextEntry) &&
    fs.existsSync(path.join(packageRoot, '.next'))
  ) {
    const webLogPath = path.join(logsDir, 'web.log');
    const webLogFd = fs.openSync(webLogPath, 'a');
    const webChild = spawn(
      'node',
      [
        nextEntry,
        'start',
        '-p',
        String(ports.cockpitPort),
        '-H',
        '127.0.0.1',
      ],
      {
        cwd: packageRoot,
        detached: true,
        stdio: ['ignore', webLogFd, webLogFd],
        env: {
          ...process.env,
          // Tell the cockpit's server-side proxy where the daemon is.
          // Without this the proxy would fall through to the legacy
          // 7707 default and miss our shifted port.
          CHORUS_DAEMON_URL: `http://127.0.0.1:${ports.daemonPort}`,
          PORT: String(ports.cockpitPort),
        },
      },
    );
    if (webChild.pid) {
      fs.writeFileSync(webPidFile, webChild.pid.toString());
      cockpitPid = webChild.pid;
      webChild.unref();
    }
  } else {
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
      c.dim(
        `    The daemon API is still up on port ${ports.daemonPort} if you only need MCP.`,
      ),
    );
    console.log('');
  }

  // Wait for the daemon to answer health, THEN write daemon.json.
  // Must await: the parent CLI process exits as soon as this function
  // returns; if we fire-and-forget, the file never gets written and
  // every consumer falls back to defaults forever.
  await waitForDaemonListenerThenRecord(ports, child.pid, cockpitPid);

  child.unref();

  console.log('');
  console.log(header(sym.ok, 'Chorus started', `daemon PID ${child.pid}`));
  if (!options.daemonOnly) {
    const cockpitUrl = `http://127.0.0.1:${ports.cockpitPort}`;
    console.log('');
    console.log(`   ${c.gray('Open')}  ${c.cyan(cockpitUrl)}`);
    const env = detectRuntimeEnv();
    if (env.hint) {
      console.log('');
      console.log(tip(env.hint));
    }
  }
  console.log('');
}

/**
 * Poll the daemon's health endpoint up to 5 seconds, then write
 * daemon.json once it responds. Background fire-and-forget — the
 * caller has already returned to the user; we just need to make sure
 * the file is in place before any consumer reads it.
 *
 * If the daemon never comes up, write the file anyway with the recorded
 * ports — better stale data than no data, since the next `chorus start`
 * will detect the dead daemon via PID liveness and overwrite.
 */
async function waitForDaemonListenerThenRecord(
  ports: PortPair,
  daemonPid: number,
  cockpitPid: number | null,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 500);
      const res = await fetch(
        `http://127.0.0.1:${ports.daemonPort}/api/v1/health`,
        { signal: ac.signal },
      );
      clearTimeout(timer);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (!isPidAlive(daemonPid)) {
      // Spawned process died before the listener came up — bail rather
      // than write a junk daemon.json.
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  writeDaemonInfo({
    schemaVersion: 1,
    daemonPort: ports.daemonPort,
    cockpitPort: ports.cockpitPort,
    daemonPid,
    cockpitPid,
    startedAt: new Date().toISOString(),
    version: pkg.version,
  });
}

function scheduleAutoOpenBrowser(
  uiFlag: boolean | undefined,
  cockpitPort: number,
): void {
  setTimeout(() => {
    if (uiFlag && shouldAutoOpenBrowser(detectRuntimeEnv())) {
      open(`http://127.0.0.1:${cockpitPort}`);
    }
  }, 1000);
}
