import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import open from 'open';
import net from 'net';
import { templates, getDb, resolveDbPath } from '../lib/db';
import { detectRuntimeEnv, shouldAutoOpenBrowser } from './runtime-env.js';
import { c, sym, header, kv, tip } from './ui.js';

const COCKPIT_URL = 'http://127.0.0.1:5050';
const DAEMON_URL = 'http://127.0.0.1:7707';

/**
 * Absolute path to bin/chorus.mjs. We resolve from __dirname so the path is
 * correct whether the CLI is being run via:
 *   - `npm i -g chorus` → /usr/local/lib/node_modules/chorus/dist/cli/index.js
 *   - tsx dev mode      → /home/.../chorus/src/cli/index.ts
 *   - direct dist       → /home/.../chorus/dist/cli/index.js
 * In every case <pkg-root>/bin/chorus.mjs is the right MCP entry point.
 *
 * `process.argv[1]` would also work for the npm-installed case, but in tsx
 * dev mode it points at the .ts file which `node` can't execute directly.
 */
const CHORUS_BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'chorus.mjs');

/**
 * Probe whether anything is listening on a TCP port on 127.0.0.1.
 *
 * Used by the start-path orphan reaper: if a previous `next-server` from
 * an earlier `chorus start` survived a `chorus stop` (because the pidfile
 * was lost or the SIGTERM was ignored), the next start would silently
 * race against it on :5050 and leave the user stuck on stale chunks
 * after a rebuild.
 */
function isPortInUse(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(inUse);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * Find any process holding a TCP listener on `port` on 127.0.0.1.
 * Returns the PIDs found via `ss`/`lsof`. Best-effort — returns [] on
 * platforms where neither tool is available.
 *
 * Why: pidfile-based tracking is fragile (file deleted on a partial
 * stop, PID reused by an unrelated process, etc). Port-based reaping
 * is the source of truth — if something's bound to :5050, we want it
 * gone before we spawn our own.
 */
function findPidsOnPort(port: number): number[] {
  const candidates: { cmd: string; parse: (out: string) => number[] }[] = [
    {
      cmd: `ss -ltnp 'sport = :${port}' 2>/dev/null`,
      parse: (out) => {
        const pids: number[] = [];
        for (const m of out.matchAll(/pid=(\d+)/g)) {
          const pid = parseInt(m[1], 10);
          if (Number.isFinite(pid) && pid > 0) pids.push(pid);
        }
        return pids;
      },
    },
    {
      cmd: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`,
      parse: (out) => out
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0),
    },
  ];
  for (const { cmd, parse } of candidates) {
    try {
      const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = parse(out);
      if (pids.length > 0) return Array.from(new Set(pids));
    } catch {
      /* tool not present or no match — try next */
    }
  }
  return [];
}

/**
 * Send a signal to a PID and wait up to `gracefulMs` for it to die. If
 * still alive, escalate to SIGKILL. Returns true if the process is gone
 * by the time we return (or never existed in the first place), false if
 * SIGKILL also failed (shouldn't happen on a normal user process).
 */
async function killAndVerify(pid: number, label: string, gracefulMs = 1500): Promise<boolean> {
  const isAlive = (): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  if (!isAlive()) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone already */ }

  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Stubborn — escalate.
  try { process.kill(pid, 'SIGKILL'); } catch { /* may already be dead */ }
  // Brief grace for kernel to reap.
  await new Promise((r) => setTimeout(r, 200));
  if (!isAlive()) return true;
  console.warn(`  ${sym.err} ${label} PID ${pid} survived SIGKILL — manual cleanup needed`);
  return false;
}

function printCockpitAccessHint(): void {
  const env = detectRuntimeEnv();
  console.log('');
  console.log(`   ${c.gray('Open')}  ${c.cyan(COCKPIT_URL)}`);
  if (env.hint) {
    console.log('');
    console.log(tip(env.hint));
  }
  console.log('');
}

// Read version from the shipped package.json so it can never drift.
// __dirname is dist/cli (built) or src/cli (tsx dev); ../../package.json
// resolves to the package root in both layouts.
const pkg: { version: string; name: string } = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string; name?: string };
    return { version: parsed.version ?? '0.0.0', name: parsed.name ?? 'chorus' };
  } catch {
    return { version: '0.0.0', name: 'chorus' };
  }
})();

const program = new Command();

program
  .name('chorus')
  .description('Driver-agnostic multi-LLM peer review for code decisions')
  .version(pkg.version);

// Show a quick-start banner before the standard help so first-time users see
// the setup sequence even when npm's global install hides postinstall stdout.
// State-aware: detects whether init has been run (chorus.db is the marker —
// dir alone is not enough, an empty ~/.chorus can exist from a prior aborted
// install) and whether the daemon is currently up.
program.addHelpText(
  'beforeAll',
  () => {
    const chorusDir = path.join(os.homedir(), '.chorus');
    const dbFile = path.join(chorusDir, 'chorus.db');
    const daemonPid = path.join(chorusDir, 'daemon.pid');
    const initialised = fs.existsSync(dbFile);
    const running = fs.existsSync(daemonPid);

    if (!initialised) {
      return [
        '',
        `  ${sym.rocket} ${c.bold('Welcome to Chorus')} ${c.dim('— two commands to get going:')}`,
        '',
        `    ${c.cyan('1.')} ${c.bold('chorus init')}     ${c.dim('register MCP with your editors + seed templates + detect CLIs')}`,
        `    ${c.cyan('2.')} ${c.bold('chorus start')}    ${c.dim('bring up the daemon + cockpit at')} ${c.cyan('http://127.0.0.1:5050')}`,
        '',
      ].join('\n');
    }
    if (!running) {
      return [
        '',
        `  ${sym.pointer} ${c.bold('Daemon is stopped.')} ${c.dim('Bring it back up:')}`,
        '',
        `    ${c.bold('chorus start')}`,
        '',
      ].join('\n');
    }
    return '';
  }
);

/**
 * Detect which reviewer CLIs (claude/codex/gemini/opencode/kimi) are usable
 * on the host. Returns the list of human-friendly names that passed the
 * full detect-and-verify probe. Used by `chorus init` to warn when zero
 * are installed — the cockpit would otherwise look healthy but every run
 * would hang on first dispatch.
 */
interface ReviewerDetect {
  /** Detected CLI labels (empty when none found and detection succeeded). */
  clis: string[];
  /** True when the detector itself crashed; caller should surface a distinct
   *  warning rather than the regular "no CLIs found" message. Pre-fix, the
   *  crash was masked by returning a fake "(detection failed)" entry which
   *  the success branch then printed as if it were a real CLI. */
  detectFailed: boolean;
  detectError?: string;
}

async function detectReviewerClis(): Promise<ReviewerDetect> {
  try {
    const { detectAllClis } = await import('../lib/cli-detect.js');
    const all = detectAllClis();
    const labelMap: Record<string, string> = {
      'claude-code': 'claude',
      'codex-cli': 'codex',
      'gemini-cli': 'gemini',
      'opencode-cli': 'opencode',
      'kimi-cli': 'kimi',
    };
    return {
      clis: all.filter((d) => d.found).map((d) => labelMap[d.id] ?? d.id),
      detectFailed: false,
    };
  } catch (err) {
    return {
      clis: [],
      detectFailed: true,
      detectError: err instanceof Error ? err.message : String(err),
    };
  }
}

// Command: chorus init
program
  .command('init')
  .description('Initialize Chorus: create ~/.chorus/, seed database, register MCP with detected editors')
  .option('--no-register', 'Skip auto-detecting orchestrators')
  .option(
    '--connect <list>',
    'Comma-separated list of CLIs to connect (claude,codex,gemini,opencode,kimi,cursor,windsurf). Default: all detected.',
  )
  .action(async (opts: { register?: boolean; connect?: string }) => {
    try {
      const chorusDir = path.join(os.homedir(), '.chorus');

      console.log('');
      console.log(header(sym.pointer, 'Initializing Chorus...'));
      console.log('');

      // Create directory
      if (!fs.existsSync(chorusDir)) {
        fs.mkdirSync(chorusDir, { recursive: true });
        console.log(`  ${sym.ok} ${c.dim('created')} ${chorusDir}`);
      }

      // Initialize DB (this will seed schema)
      await getDb();
      // Honour CHORUS_DB_PATH override — print the path the daemon will
      // actually use, not the default. Hardcoding ~/.chorus/chorus.db here
      // misled users who'd set the env var and then "where's my DB?".
      console.log(`  ${sym.ok} ${c.dim('database ready at')} ${resolveDbPath()}`);

      // Copy built-in templates
      const templatesDir = path.join(__dirname, '..', '..', 'templates');

      if (fs.existsSync(templatesDir)) {
        const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
        const seeded: string[] = [];

        for (const file of files) {
          const id = file.replace('.yaml', '');
          const yamlPath = path.join(templatesDir, file);
          const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

          const existing = await templates.getById(id);

          if (!existing) {
            await templates.create(id, yamlContent, 'builtin');
            seeded.push(id);
          }
        }
        if (seeded.length > 0) {
          console.log(`  ${sym.ok} ${c.dim('seeded templates:')} ${c.cyan(seeded.join(', '))}`);
        } else {
          console.log(`  ${sym.ok} ${c.dim('templates already up to date')}`);
        }
      }

      // Auto-detect & register every supported orchestrator on the host.
      // Skipped if user passes --no-register; restricted via --connect <list>.
      if (opts.register !== false) {
        await runOrchestratorAutoConnect(opts.connect);
      }

      // Reviewer-CLI presence check — separate from orchestrator wiring above.
      // Without at least one of claude/codex/gemini/opencode/kimi installed
      // OR an OpenRouter API key configured, Chorus has nothing to dispatch
      // chats to. Used to be silent; now we surface it so the user doesn't
      // reach the cockpit and wonder why every run hangs.
      const detect = await detectReviewerClis();
      if (detect.detectFailed) {
        console.log('');
        console.log(`  ${c.yellow('!')} ${c.bold(c.yellow('CLI detection crashed:'))} ${detect.detectError ?? 'unknown error'}`);
        console.log(c.dim('    Init continued anyway — verify reviewers in Settings → Voices once you start the cockpit.'));
      } else if (detect.clis.length === 0) {
        console.log('');
        console.log(`  ${c.yellow('!')} ${c.bold(c.yellow('No AI CLIs detected on this machine.'))}`);
        console.log(c.dim('    Chorus needs at least one of these (or an OpenRouter API key):'));
        console.log(c.dim('      claude     — https://docs.anthropic.com/en/docs/claude-code'));
        console.log(c.dim('      codex      — https://github.com/openai/codex'));
        console.log(c.dim('      gemini     — https://github.com/google-gemini/gemini-cli'));
        console.log(c.dim('      opencode   — https://opencode.ai'));
        console.log(c.dim('      kimi       — https://github.com/MoonshotAI/kimi-cli'));
        console.log(c.dim('      openrouter — Settings → Voices → Add OpenRouter (uses your API key)'));
        console.log(c.dim('    Install at least one CLI, or add an OpenRouter voice after `chorus start`.'));
      } else {
        console.log('');
        console.log(`  ${sym.ok} ${c.dim('AI CLIs ready:')} ${c.cyan(detect.clis.join(', '))}`);
      }

      console.log('');
      console.log(header(sym.ok, 'Chorus initialized'));
      console.log('');
      console.log(`  ${c.dim('Next:')} ${c.bold('chorus start')} ${c.dim('— bring up the daemon and cockpit.')}`);
      console.log(`  ${c.dim('Then restart any editor we just registered (Claude Code, etc.) so it picks up the MCP server.')}`);
      console.log('');
    } catch (error) {
      console.error(`${sym.err} ${c.red('Initialization failed:')}`, error);
      process.exit(1);
    }
  });

/**
 * Detect Claude Code / Codex / Gemini / OpenCode and wire each one.
 * If the user passed `--connect <list>` we only touch those.
 * Prints a summary line per CLI.
 */
async function runOrchestratorAutoConnect(connectFlag?: string): Promise<void> {
  const { autoConnectAll, detectOrchestrators } = await import('../daemon/orchestrators.js');
  const binPath = CHORUS_BIN_PATH;

  type Name = 'claude' | 'codex' | 'gemini' | 'opencode' | 'kimi' | 'cursor' | 'windsurf';
  const ALL_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'kimi', 'cursor', 'windsurf'] as const;

  let only: Name[] | undefined;
  if (connectFlag) {
    const wanted = connectFlag.split(',').map((s) => s.trim().toLowerCase());
    only = [];
    for (const w of wanted) {
      if ((ALL_NAMES as readonly string[]).includes(w)) {
        only.push(w as Name);
      } else {
        console.error(`Unknown orchestrator '${w}' in --connect. Valid: ${ALL_NAMES.join(', ')}`);
        process.exit(1);
      }
    }
  }

  console.log('');
  console.log(`  ${c.dim('Detecting orchestrators...')}`);

  const result = await autoConnectAll({ binPath, ...(only ? { only } : {}) });

  for (const step of result.steps) {
    if (!step.detected) {
      console.log(`  ${c.gray('○')} ${c.gray(step.label.padEnd(14))} ${c.dim('not detected')}`);
      continue;
    }
    if (step.error) {
      console.log(`  ${c.yellow('!')} ${c.yellow(step.label.padEnd(14))} ${c.dim(step.error)}`);
      continue;
    }
    const parts: string[] = [];
    if (step.registered) parts.push('MCP registered');
    else parts.push('MCP already registered');
    if (step.toolsAdded > 0) parts.push(`${step.toolsAdded} tool(s) approved`);
    else if (step.name === 'claude') parts.push('all tools approved');
    if (step.slashCommand === 'installed') parts.push('/chorus installed');
    else if (step.slashCommand === 'updated') parts.push('/chorus updated');
    console.log(`  ${sym.ok} ${c.bold(step.label.padEnd(14))} ${c.dim(parts.join(' · '))}`);
  }

  if (!result.anyConnected) {
    console.log('');
    console.log(`  ${sym.info} ${c.dim('No supported editors found. Connect manually later with')} ${c.bold('chorus connect')}`);
  }
}

// Command: chorus start
program
  .command('start')
  .option('--ui', 'Open browser UI after starting daemon')
  .description('Start the Chorus daemon (PM2-style fork)')
  .action(async (options) => {
    try {
      const chorusDir = path.join(os.homedir(), '.chorus');
      const pidFile = path.join(chorusDir, 'daemon.pid');

      // Check if already running
      if (fs.existsSync(pidFile)) {
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

          if (options.ui && shouldAutoOpenBrowser(detectRuntimeEnv())) {
            open(COCKPIT_URL);
          }

          return;
        } catch {
          // Process doesn't exist, clean up
          fs.unlinkSync(pidFile);
        }
      }

      // Pre-spawn orphan reap. Pidfile-based liveness above only catches
      // the recorded daemon PID — it misses a stale next-server (cockpit)
      // or daemon that survived a previous `chorus stop` because the
      // SIGTERM was ignored or the pidfile got out of sync. Without this
      // sweep, a fresh `chorus start` would race against the orphan on
      // :5050 / :7707, the new spawn would lose, and the user would see
      // 500s served by the ghost (incident 2026-05-03).
      for (const [port, label] of [[7707, 'daemon'], [5050, 'cockpit']] as const) {
        if (await isPortInUse(port)) {
          const pids = findPidsOnPort(port);
          for (const pid of pids) {
            const dead = await killAndVerify(pid, `${label} orphan`);
            if (dead) {
              console.log(
                `  ${sym.ok} reaped ${label} orphan on :${port} ${c.dim(`(PID ${pid})`)}`,
              );
            }
          }
        }
      }

      // Spawn daemon. Prefer the compiled JS so a global install (no src/
      // shipped, no tsx loader registered) works; fall back to the .ts source
      // when running in dev mode where the user only has src/ on disk.
      const daemonJs = path.resolve(__dirname, '..', 'daemon', 'index.js');
      const daemonTs = path.resolve(__dirname, '..', '..', 'src', 'daemon', 'index.ts');
      const useCompiled = fs.existsSync(daemonJs);
      const daemonPath = useCompiled ? daemonJs : daemonTs;
      const spawnArgs = useCompiled ? [daemonPath] : ['-r', 'tsx/cjs', daemonPath];

      // Pipe daemon stdout + stderr to a log file in ~/.chorus/logs/ so the
      // user (and we, when debugging) can see why a chat went sideways.
      // Previously stdio was 'ignore' which made silent failures impossible
      // to diagnose. Logs rotate manually; truncated to 10 MB max via
      // periodic rotate inside the daemon (TODO).
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

      // Write PID
      fs.writeFileSync(pidFile, child.pid.toString());

      // Spawn the cockpit web UI alongside the daemon. The package ships a
      // built .next directory; run next from the package root so it picks up
      // the bundled bun_modules. Web PID is tracked separately so `chorus
      // stop` can clean up both.
      const packageRoot = useCompiled
        ? path.resolve(__dirname, '..', '..')
        : path.resolve(__dirname, '..', '..');
      const nextEntry = path.resolve(packageRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
      const webPidFile = path.join(chorusDir, 'web.pid');
      if (fs.existsSync(nextEntry) && fs.existsSync(path.join(packageRoot, '.next'))) {
        const webLogPath = path.join(logsDir, 'web.log');
        const webLogFd = fs.openSync(webLogPath, 'a');
        const webChild = spawn('node', [nextEntry, 'start', '-p', '5050', '-H', '127.0.0.1'], {
          cwd: packageRoot,
          detached: true,
          stdio: ['ignore', webLogFd, webLogFd],
        });
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
          console.log(c.dim('    The published install should ship a built UI. Try reinstalling:'));
          console.log(`    ${c.bold('npm install -g chorus')}`);
        }
        console.log(c.dim('    The daemon API is still up on port 7707 if you only need MCP.'));
        console.log('');
      }

      // Unref so parent doesn't wait
      child.unref();

      console.log('');
      console.log(header(sym.ok, 'Chorus started', `daemon PID ${child.pid}`));
      printCockpitAccessHint();

      // Give daemon time to start
      setTimeout(() => {
        if (options.ui && shouldAutoOpenBrowser(detectRuntimeEnv())) {
          open(COCKPIT_URL);
        }
      }, 1000);
    } catch (error) {
      console.error('Failed to start daemon:', error);
      process.exit(1);
    }
  });

// Command: chorus ui
program
  .command('ui')
  .description('Open the Chorus web UI in default browser')
  .action(async () => {
    try {
      const env = detectRuntimeEnv();
      printCockpitAccessHint();
      if (shouldAutoOpenBrowser(env)) {
        await open(COCKPIT_URL);
        console.log(`\nOpening ${COCKPIT_URL}...`);
      }
    } catch (error) {
      console.error('Failed to open browser:', error);
      process.exit(1);
    }
  });

// Command: chorus connect
program
  .command('connect [orchestrator]')
  .description('Pre-approve all Chorus MCP tools in your orchestrator (default: claude)')
  .action(async (orchestrator?: string) => {
    const { runConnect } = await import('./connect.js');
    runConnect(orchestrator);
  });

// Command: chorus mcp
program
  .command('mcp')
  .description('Run the MCP server on stdio (for orchestrators)')
  .action(async () => {
    // Hand off stdio to the MCP server. This call never returns under normal
    // operation — the orchestrator (Claude Code, Codex, Cursor) holds the
    // pipe open and pumps JSON-RPC messages until it shuts the child down.
    await import('../mcp/index.js');
  });

// Command: chorus stop
//
// Two-stage shutdown per managed process: SIGTERM, wait up to 1.5s, escalate
// to SIGKILL if still alive. Don't unlink the pidfile until the process is
// confirmed dead — otherwise an orphan that ignores SIGTERM keeps running
// while we forget about it (the bug behind the "stale next-server serving
// 500s" incident on 2026-05-03).
//
// Belt-and-braces: after pidfile-based shutdown, also sweep ports :7707
// (daemon) and :5050 (cockpit). Catches the case where the pidfile was lost
// or pointed at a recycled PID but a real chorus process still owns the port.
program
  .command('stop')
  .description('Stop the Chorus daemon and cockpit')
  .action(async () => {
    try {
      const chorusDir = path.join(os.homedir(), '.chorus');
      const daemonPidFile = path.join(chorusDir, 'daemon.pid');
      const webPidFile = path.join(chorusDir, 'web.pid');

      const daemonPidfileExists = fs.existsSync(daemonPidFile);
      const webPidfileExists = fs.existsSync(webPidFile);
      const daemonPortInUse = await isPortInUse(7707);
      const cockpitPortInUse = await isPortInUse(5050);

      if (
        !daemonPidfileExists &&
        !webPidfileExists &&
        !daemonPortInUse &&
        !cockpitPortInUse
      ) {
        console.log('');
        console.log(header(sym.info, 'Chorus is not running', 'nothing to stop'));
        console.log('');
        return;
      }

      console.log('');
      console.log(header(sym.pointer, 'Stopping Chorus...'));
      console.log('');

      const stopProcess = async (label: string, pidFile: string): Promise<void> => {
        if (!fs.existsSync(pidFile)) return;
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
        if (!Number.isFinite(pid) || pid <= 0) {
          fs.unlinkSync(pidFile);
          return;
        }
        const dead = await killAndVerify(pid, label);
        if (dead) {
          console.log(`  ${sym.ok} ${label.padEnd(7)} ${c.dim(`(PID ${pid})`)}`);
          // Only unlink once we've confirmed the process is gone. Earlier
          // code unconditionally unlinked, which orphaned any process that
          // ignored SIGTERM — its successor `chorus start` couldn't see the
          // ghost owner of the port.
          try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
        }
      };

      await stopProcess('Daemon', daemonPidFile);
      await stopProcess('Cockpit', webPidFile);

      // Port-based sweep — kills any chorus-owned listener that escaped the
      // pidfile path. Errs on the side of cleanup; running a non-chorus
      // service on these ports while invoking `chorus stop` is unsupported.
      const sweepPort = async (port: number, label: string): Promise<void> => {
        const pids = findPidsOnPort(port);
        for (const pid of pids) {
          const dead = await killAndVerify(pid, `${label} orphan`);
          if (dead) {
            console.log(`  ${sym.ok} ${label.padEnd(7)} ${c.dim(`(orphan PID ${pid} on :${port})`)}`);
          }
        }
      };
      await sweepPort(7707, 'Daemon');
      await sweepPort(5050, 'Cockpit');

      console.log('');
    } catch (error) {
      console.error(`${sym.err} ${c.red('Error stopping chorus:')}`, error);
      process.exit(1);
    }
  });

// Command: chorus status
program
  .command('status')
  .description('Check daemon health')
  .action(async () => {
    try {
      const response = await fetch('http://127.0.0.1:7707/health');

      if (!response.ok) {
        console.log('');
        console.log(header(sym.err, 'Daemon is not running', 'start with `chorus start`'));
        console.log('');
        process.exit(1);
      }

      const envelope = (await response.json()) as {
        ok: boolean;
        data?: { ok: boolean; version: string; uptime: number };
      };
      const data = envelope.data;

      if (envelope.ok && data && data.ok) {
        const uptime = Math.floor(data.uptime / 1000);
        const human =
          uptime < 60 ? `${uptime}s` : uptime < 3600 ? `${Math.floor(uptime / 60)}m` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
        console.log('');
        console.log(header(sym.ok, 'Chorus is running'));
        console.log('');
        console.log(
          kv([
            ['Version', c.cyan(data.version)],
            ['Uptime', c.dim(human)],
            ['Cockpit', c.cyan(COCKPIT_URL)],
            ['Daemon', c.dim(DAEMON_URL)],
          ])
        );
        console.log('');
      } else {
        console.log('');
        console.log(header(sym.err, 'Daemon is not responding correctly'));
        console.log('');
        process.exit(1);
      }
    } catch {
      console.log('');
      console.log(header(sym.err, 'Daemon is not running', 'start with `chorus start`'));
      console.log('');
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
