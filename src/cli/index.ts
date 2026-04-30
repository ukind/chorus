import { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import open from 'open';
import { templates, getDb } from '../lib/db';

const pkg = { version: '0.5.0-dev.0', name: 'chorus' };

const program = new Command();

program
  .name('chorus')
  .description('Driver-agnostic multi-LLM peer review for code decisions')
  .version(pkg.version);

// Command: chorus init
program
  .command('init')
  .description('Initialize Chorus: create ~/.chorus/, seed database, copy built-in templates')
  .action(() => {
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

      console.log('\nChorus initialized successfully!');
    } catch (error) {
      console.error('Initialization failed:', error);
      process.exit(1);
    }
  });

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

          if (options.ui) {
            open('http://127.0.0.1:3011');
          }

          return;
        } catch {
          // Process doesn't exist, clean up
          fs.unlinkSync(pidFile);
        }
      }

      // Spawn daemon
      const daemonPath = require.resolve('../daemon/index.ts');

      const child = spawn('node', ['-r', 'tsx/cjs', daemonPath], {
        detached: true,
        stdio: 'ignore',
      });

      if (!child.pid) {
        throw new Error('Failed to spawn daemon process');
      }

      // Write PID
      fs.mkdirSync(chorusDir, { recursive: true });
      fs.writeFileSync(pidFile, child.pid.toString());

      // Unref so parent doesn't wait
      child.unref();

      console.log(`Daemon started (PID ${child.pid})`);
      console.log(`Listening on http://127.0.0.1:7707`);

      // Give daemon time to start
      setTimeout(() => {
        if (options.ui) {
          open('http://127.0.0.1:3011');
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
      await open('http://127.0.0.1:3011');
      console.log('Opening http://127.0.0.1:3011');
    } catch (error) {
      console.error('Failed to open browser:', error);
      process.exit(1);
    }
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
      const pidFile = path.join(chorusDir, 'daemon.pid');

      if (!fs.existsSync(pidFile)) {
        console.log('Daemon is not running');
        return;
      }

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);

      try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidFile);
        console.log(`Daemon stopped (was PID ${pid})`);
      } catch (error) {
        console.error(`Failed to stop daemon: ${error}`);
        process.exit(1);
      }
    } catch (error) {
      console.error('Error stopping daemon:', error);
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
