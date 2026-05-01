import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import open from 'open';
import { templates, getDb } from '../lib/db';
import { detectRuntimeEnv, shouldAutoOpenBrowser } from './runtime-env.js';

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
  console.log(`  Cockpit UI:  ${COCKPIT_URL}`);
  console.log(`  Daemon API:  ${DAEMON_URL}`);
  if (env.hint) {
    console.log('');
    console.log(`  ${env.hint}`);
  }
}

const pkg = { version: '0.5.0-dev.0', name: 'chorus' };

const program = new Command();

program
  .name('chorus')
  .description('Driver-agnostic multi-LLM peer review for code decisions')
  .version(pkg.version);

// Show a quick-start banner before the standard help so first-time users see
// the two-step setup even when npm's global install hides postinstall stdout.
program.addHelpText(
  'beforeAll',
  () => {
    const chorusDir = path.join(os.homedir(), '.chorus');
    if (!fs.existsSync(chorusDir)) {
      return `\n  Quick start (first run):\n    chorus init    register MCP with your editors, seed templates, detect CLIs\n    chorus start   bring up the daemon + cockpit on http://127.0.0.1:5050\n`;
    }
    const daemonPid = path.join(chorusDir, 'daemon.pid');
    if (!fs.existsSync(daemonPid)) {
      return `\n  Daemon not running. Start it with:\n    chorus start\n`;
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

      // Create directory
      if (!fs.existsSync(chorusDir)) {
        fs.mkdirSync(chorusDir, { recursive: true });
        console.log(`Created ${chorusDir}`);
      }

      // Initialize DB (this will seed schema)
      getDb();
      console.log(`Database initialized at ${path.join(chorusDir, 'chorus.db')}`);

      // Copy built-in templates
      const templatesDir = path.join(__dirname, '..', '..', 'templates');

      if (fs.existsSync(templatesDir)) {
        const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));

        for (const file of files) {
          const id = file.replace('.yaml', '');
          const yamlPath = path.join(templatesDir, file);
          const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

          const existing = templates.getById(id);

          if (!existing) {
            templates.create(id, yamlContent, 'builtin');
            console.log(`Seeded template: ${id}`);
          }
        }
      }

      // Auto-detect & register every supported orchestrator on the host.
      // Skipped if user passes --no-register; restricted via --connect <list>.
      if (opts.register !== false) {
        await runOrchestratorAutoConnect(opts.connect);
      }

      console.log('\nChorus initialized successfully!');
      console.log('Next: `chorus start` to bring up the daemon, then restart any editor');
      console.log('we just registered (Claude Code, etc.) so it picks up the MCP server.');
    } catch (error) {
      console.error('Initialization failed:', error);
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

  console.log('\nDetecting orchestrators...');
  const detected = detectOrchestrators().filter((d) => d.detected);
  if (detected.length > 0 && !only) {
    console.log(`  Found: ${detected.map((d) => d.label).join(', ')}`);
    console.log('  (Pass --connect <name,name> to limit to specific CLIs.)');
  }

  const result = autoConnectAll({ binPath, ...(only ? { only } : {}) });

  for (const step of result.steps) {
    if (!step.detected) {
      console.log(`  ✗ ${step.label}: not detected`);
      continue;
    }
    if (step.error) {
      console.log(`  ! ${step.label}: ${step.error}`);
      continue;
    }
    const parts: string[] = [];
    if (step.registered) parts.push('MCP server registered');
    else parts.push('MCP already registered');
    if (step.toolsAdded > 0) parts.push(`${step.toolsAdded} tool(s) approved`);
    else if (step.name === 'claude') parts.push('all tools already approved');
    if (step.slashCommand === 'installed') parts.push('/chorus command installed');
    else if (step.slashCommand === 'updated') parts.push('/chorus command updated');
    console.log(`  ✓ ${step.label}: ${parts.join(' · ')}`);
  }

  if (!result.anyConnected) {
    console.log(
      '  (no supported editors found — to connect manually later: chorus connect)',
    );
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
          console.log(`Daemon already running (PID ${oldPid})`);
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

      const child = spawn('node', spawnArgs, {
        detached: true,
        stdio: 'ignore',
      });

      if (!child.pid) {
        throw new Error('Failed to spawn daemon process');
      }

      // Write PID
      fs.mkdirSync(chorusDir, { recursive: true });
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
        const webChild = spawn('node', [nextEntry, 'start', '-p', '5050', '-H', '127.0.0.1'], {
          cwd: packageRoot,
          detached: true,
          stdio: 'ignore',
        });
        if (webChild.pid) {
          fs.writeFileSync(webPidFile, webChild.pid.toString());
          webChild.unref();
        }
      } else {
        console.log('  (cockpit UI build not found — daemon API still available on 7707)');
      }

      // Unref so parent doesn't wait
      child.unref();

      console.log(`Daemon started (PID ${child.pid})`);
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
          console.log(`${label} stopped (was PID ${pid})`);
        } catch {
          // process already gone
        }
        fs.unlinkSync(pidFile);
      };
      const daemonPidFile = path.join(chorusDir, 'daemon.pid');
      const webPidFile = path.join(chorusDir, 'web.pid');
      if (!fs.existsSync(daemonPidFile) && !fs.existsSync(webPidFile)) {
        console.log('Chorus is not running');
        return;
      }
      stopProcess('Daemon', daemonPidFile);
      stopProcess('Cockpit', webPidFile);
    } catch (error) {
      console.error('Error stopping chorus:', error);
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
        console.log('Daemon is not running');
        process.exit(1);
      }

      const data = (await response.json()) as { ok: boolean; version: string; uptime: number };

      if (data.ok) {
        const uptime = Math.floor(data.uptime / 1000);
        console.log(`Daemon is running`);
        console.log(`  Version: ${data.version}`);
        console.log(`  Uptime: ${uptime}s`);
      } else {
        console.log('Daemon is not responding correctly');
        process.exit(1);
      }
    } catch {
      console.log('Daemon is not running');
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
