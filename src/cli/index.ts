import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import open from 'open';
import { templates, getDb } from '../lib/db';
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
      getDb();
      console.log(`  ${sym.ok} ${c.dim('database ready at')} ${path.join(chorusDir, 'chorus.db')}`);

      // Copy built-in templates
      const templatesDir = path.join(__dirname, '..', '..', 'templates');

      if (fs.existsSync(templatesDir)) {
        const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
        const seeded: string[] = [];

        for (const file of files) {
          const id = file.replace('.yaml', '');
          const yamlPath = path.join(templatesDir, file);
          const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

          const existing = templates.getById(id);

          if (!existing) {
            templates.create(id, yamlContent, 'builtin');
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

  const result = autoConnectAll({ binPath, ...(only ? { only } : {}) });

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
  .action((options) => {
    try {
      const chorusDir = path.join(os.homedir(), '.chorus');
      const pidFile = path.join(chorusDir, 'daemon.pid');

      // Check if already running
      if (fs.existsSync(pidFile)) {
        const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);

        try {
          execSync(`kill -0 ${oldPid}`, { stdio: 'ignore' });
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
        console.log(c.yellow('  ! cockpit UI build not found — daemon API still available on 7707'));
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
program
  .command('stop')
  .description('Stop the Chorus daemon')
  .action(() => {
    try {
      const chorusDir = path.join(os.homedir(), '.chorus');
      const stopProcess = (label: string, pidFile: string): void => {
        if (!fs.existsSync(pidFile)) return;
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`  ${sym.ok} ${label.padEnd(7)} ${c.dim(`(PID ${pid})`)}`);
        } catch {
          // process already gone
        }
        fs.unlinkSync(pidFile);
      };
      const daemonPidFile = path.join(chorusDir, 'daemon.pid');
      const webPidFile = path.join(chorusDir, 'web.pid');
      if (!fs.existsSync(daemonPidFile) && !fs.existsSync(webPidFile)) {
        console.log('');
        console.log(header(sym.info, 'Chorus is not running', 'nothing to stop'));
        console.log('');
        return;
      }
      console.log('');
      console.log(header(sym.pointer, 'Stopping Chorus...'));
      console.log('');
      stopProcess('Daemon', daemonPidFile);
      stopProcess('Cockpit', webPidFile);
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
