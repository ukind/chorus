/**
 * Orchestrator integrations: pre-approve Chorus's MCP tools in third-party
 * editors / CLIs so users don't get prompted on every tool call.
 *
 * Same logic the `chorus connect` CLI uses, exposed via daemon HTTP so the
 * cockpit's /connect page can do it with one click.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const CHORUS_TOOLS = [
  'mcp__chorus__create_chat',
  'mcp__chorus__wait_for_chat',
  'mcp__chorus__get_chat_status',
  'mcp__chorus__list_blocked',
  'mcp__chorus__resume_chat',
  'mcp__chorus__cancel_chat',
  'mcp__chorus__list_templates',
];

export type OrchestratorName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'kimi'
  | 'cursor'
  | 'windsurf';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7707';

export interface OrchestratorStatus {
  name: OrchestratorName;
  label: string;
  /** True when Chorus's MCP tools are pre-approved (all of them). */
  connected: boolean;
  /** How many of CHORUS_TOOLS are pre-approved right now. */
  approvedTools: number;
  /** Total expected (always CHORUS_TOOLS.length for now). */
  totalTools: number;
  /** Human note for "what does connecting do?" UX copy. */
  note: string;
  /** False = we know how to detect/connect; true = stub for future. */
  supported: boolean;
  /**
   * What happens the first time the user calls a chorus.* tool from inside
   * this CLI?
   *
   * - `auto`: tools fire without any prompt (we've pre-approved them).
   * - `prompts_once`: CLI shows a one-time prompt; user clicks "Always allow"
   *   and the prompt is gone forever. We don't have a config-file way to skip
   *   this for these CLIs.
   * - `inherits_global`: depends on the user's broader CLI config (e.g.
   *   Codex's `approval_policy`). We don't override their setting.
   */
  firstCallBehavior: 'auto' | 'prompts_once' | 'inherits_global';
}

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
    additionalDirectories?: string[];
  };
  [key: string]: unknown;
}

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.local.json');

function readClaudeSettings(): ClaudeSettings {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function getClaudeStatus(): OrchestratorStatus {
  const config = readClaudeSettings();
  const allow = new Set(config.permissions?.allow ?? []);
  const approved = CHORUS_TOOLS.filter((t) => allow.has(t)).length;
  return {
    name: 'claude',
    label: 'Claude Code',
    connected: approved === CHORUS_TOOLS.length,
    approvedTools: approved,
    totalTools: CHORUS_TOOLS.length,
    note: 'Pre-approves the 7 chorus.* tools so Claude Code doesn\'t prompt per-tool.',
    supported: true,
    firstCallBehavior: 'auto',
  };
}

/**
 * List all orchestrator statuses for the /connect page.
 */
export function listOrchestrators(): OrchestratorStatus[] {
  return [
    getClaudeStatus(),
    getCodexStatus(),
    getGeminiStatus(),
    getOpencodeStatus(),
    getKimiStatus(),
    getCursorStatus(),
    getWindsurfStatus(),
  ];
}

export interface ConnectResult {
  added: string[];
  alreadyPresent: string[];
  configPath: string;
  /**
   * State of the `/chorus` slash command in `~/.claude/commands/chorus.md`.
   * - `installed` = file did not exist, we wrote it
   * - `updated` = file existed with stale contents, we overwrote it
   * - `unchanged` = file already matched the current asset
   * - `skipped` = source asset not found (unbundled dev checkout)
   */
  slashCommand: 'installed' | 'updated' | 'unchanged' | 'skipped';
  slashCommandPath: string;
}

const CLAUDE_SLASH_COMMAND_PATH = path.join(os.homedir(), '.claude', 'commands', 'chorus.md');

/**
 * Resolve the bundled `/chorus` slash command markdown shipped in the npm
 * package at `assets/slash-commands/chorus.md`. Works in both dist (`__dirname`
 * = `dist/daemon`) and dev/tsx (`__dirname` = `src/daemon`) — both resolve to
 * `<pkg>/assets/...`.
 */
function resolveChorusSlashAsset(): string | null {
  const candidate = path.join(__dirname, '..', '..', 'assets', 'slash-commands', 'chorus.md');
  return fs.existsSync(candidate) ? candidate : null;
}

function installChorusSlashCommand(): ConnectResult['slashCommand'] {
  const source = resolveChorusSlashAsset();
  if (!source) return 'skipped';
  const desired = fs.readFileSync(source, 'utf-8');

  if (fs.existsSync(CLAUDE_SLASH_COMMAND_PATH)) {
    const current = fs.readFileSync(CLAUDE_SLASH_COMMAND_PATH, 'utf-8');
    if (current === desired) return 'unchanged';
    fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, 'utf-8');
    return 'updated';
  }

  fs.mkdirSync(path.dirname(CLAUDE_SLASH_COMMAND_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, 'utf-8');
  return 'installed';
}

/**
 * Patch Claude Code's local settings to whitelist all 7 Chorus MCP tools, and
 * drop the `/chorus` slash command into `~/.claude/commands/`. Idempotent.
 */
export function connectClaude(): ConnectResult {
  const config = readClaudeSettings();
  const permissions = (config.permissions ?? {}) as NonNullable<ClaudeSettings['permissions']>;
  const existing = new Set(permissions.allow ?? []);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const tool of CHORUS_TOOLS) {
    if (existing.has(tool)) {
      alreadyPresent.push(tool);
    } else {
      existing.add(tool);
      added.push(tool);
    }
  }

  if (added.length > 0) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    const next: ClaudeSettings = {
      ...config,
      permissions: {
        ...permissions,
        allow: Array.from(existing).sort(),
      },
    };
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  }

  const slashCommand = installChorusSlashCommand();

  return {
    added,
    alreadyPresent,
    configPath: CLAUDE_SETTINGS_PATH,
    slashCommand,
    slashCommandPath: CLAUDE_SLASH_COMMAND_PATH,
  };
}

// ─── Codex CLI ──────────────────────────────────────────────────────────────

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

function getCodexStatus(): OrchestratorStatus {
  const detected = fs.existsSync(CODEX_CONFIG_PATH);
  const connected = detected && hasCodexMcpServer();
  return {
    name: 'codex',
    label: 'Codex CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus as an MCP server in ~/.codex/config.toml. Whether tool calls prompt depends on your codex `approval_policy` setting (we don\'t change it).',
    supported: detected,
    firstCallBehavior: 'inherits_global',
  };
}

function hasCodexMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  const body = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  if (!/^\[mcp_servers\.chorus\]/m.test(body)) return false;
  if (!expectedBinPath) return true;
  return body.includes(expectedBinPath);
}

/**
 * Register Chorus as an MCP server in Codex via `codex mcp add`. We shell out
 * rather than write TOML by hand so we always emit the exact format Codex
 * expects — and stay forward-compatible if it changes.
 *
 * Idempotent: if the entry already exists we skip the call.
 */
export function connectCodex(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  if (hasCodexMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcp_servers.chorus'],
      configPath: CODEX_CONFIG_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  // If a stale entry exists with a different binPath, remove it first.
  if (hasCodexMcpServer()) {
    try {
      execFileSync('codex', ['mcp', 'remove', 'chorus'], { stdio: 'pipe' });
    } catch {
      // best-effort
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    execFileSync(
      'codex',
      [
        'mcp', 'add', 'chorus',
        '--env', `CHORUS_DAEMON_URL=${daemonUrl}`,
        '--', 'node', opts.binPath, 'mcp',
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`codex mcp add failed: ${msg}`);
  }

  return {
    added: ['mcp_servers.chorus'],
    alreadyPresent: [],
    configPath: CODEX_CONFIG_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

// ─── Gemini CLI ─────────────────────────────────────────────────────────────

const GEMINI_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');

function getGeminiStatus(): OrchestratorStatus {
  const detected = fs.existsSync(GEMINI_SETTINGS_PATH);
  const connected = detected && hasGeminiMcpServer();
  return {
    name: 'gemini',
    label: 'Gemini CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus as a user-scope MCP server in ~/.gemini/settings.json with --trust set so calls don\'t prompt.',
    supported: detected,
    firstCallBehavior: 'auto',
  };
}

function hasGeminiMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(GEMINI_SETTINGS_PATH)) return false;
  try {
    const body = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8')) as Record<
      string,
      unknown
    >;
    const servers = body.mcpServers as Record<string, unknown> | undefined;
    const chorus = servers?.chorus as { args?: string[] } | undefined;
    if (!chorus) return false;
    if (!expectedBinPath) return true;
    return Array.isArray(chorus.args) && chorus.args.includes(expectedBinPath);
  } catch {
    return false;
  }
}

/**
 * Register Chorus with Gemini CLI. `gemini mcp add` writes to ~/.gemini/settings.json
 * (or per-project) for us — we use --scope user to make it global.
 *
 * Idempotent: skips if already present.
 */
export function connectGemini(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  if (hasGeminiMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: GEMINI_SETTINGS_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  // Stale entry with different binPath — remove (user-scope) before re-add.
  if (hasGeminiMcpServer()) {
    try {
      execFileSync('gemini', ['mcp', 'remove', 'chorus', '-s', 'user'], { stdio: 'pipe' });
    } catch {
      // best-effort
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    execFileSync(
      'gemini',
      [
        'mcp', 'add', 'chorus',
        'node', opts.binPath, 'mcp',
        '-e', `CHORUS_DAEMON_URL=${daemonUrl}`,
        '-s', 'user',
        '-t', 'stdio',
        '--trust',
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gemini mcp add failed: ${msg}`);
  }

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: GEMINI_SETTINGS_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

// ─── OpenCode ───────────────────────────────────────────────────────────────

const OPENCODE_USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  permission?: {
    edit?: 'ask' | 'allow' | 'deny';
    bash?: Record<string, 'ask' | 'allow' | 'deny'>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Safe-bash allowlist for OpenCode reviewers. Read-only ops that reviewers
 * legitimately need to inspect a diff (git diff, ls, cat, grep, find) — these
 * shouldn't prompt every spawn. Destructive ops (rm, git push, git reset) fall
 * through to `*: ask` which preserves the safety gate.
 *
 * Layer 1 of the three-layer permission model: prevent the dialog from
 * appearing in the first place. Layer 2 (shim.recoverKeys) catches anything
 * this misses.
 */
const OPENCODE_SAFE_BASH: Record<string, 'allow' | 'ask' | 'deny'> = {
  'git diff': 'allow',
  'git diff *': 'allow',
  'git status': 'allow',
  'git log': 'allow',
  'git log *': 'allow',
  'git show *': 'allow',
  'git blame *': 'allow',
  cat: 'allow',
  'cat *': 'allow',
  ls: 'allow',
  'ls *': 'allow',
  'find *': 'allow',
  'rg *': 'allow',
  'grep *': 'allow',
  'head *': 'allow',
  'tail *': 'allow',
  'wc *': 'allow',
  'pwd': 'allow',
  'echo *': 'allow',
  '*': 'ask',
};

function readOpencodeConfig(): { config: OpencodeConfig; existed: boolean } {
  if (!fs.existsSync(OPENCODE_USER_CONFIG_PATH)) {
    return { config: {}, existed: false };
  }
  try {
    return {
      config: JSON.parse(fs.readFileSync(OPENCODE_USER_CONFIG_PATH, 'utf-8')) as OpencodeConfig,
      existed: true,
    };
  } catch {
    return { config: {}, existed: true };
  }
}

function getOpencodeStatus(): OrchestratorStatus {
  const detected = fs.existsSync(path.dirname(OPENCODE_USER_CONFIG_PATH));
  const { config } = readOpencodeConfig();
  const connected = detected && Boolean(config.mcp && (config.mcp as Record<string, unknown>).chorus);
  return {
    name: 'opencode',
    label: 'OpenCode',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus as a local MCP server in ~/.config/opencode/opencode.json with `enabled: true` so the agent can call its tools.',
    supported: detected,
    firstCallBehavior: 'auto',
  };
}

/**
 * Register Chorus with OpenCode. `opencode mcp add` is interactive (no flags
 * for non-tty use), so we patch the user-scope config directly.
 * Idempotent.
 */
export function connectOpencode(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  const { config } = readOpencodeConfig();
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;

  const existing = mcp.chorus as { command?: string[] } | undefined;
  const existingBinMatches =
    existing && Array.isArray(existing.command) && existing.command.includes(opts.binPath);

  // Bash pre-approval is independent of the MCP block — pre-approve even if
  // the MCP block is already correct, in case the user's existing config
  // doesn't have it. Idempotent merge: never overwrite a user's explicit
  // setting, only fill gaps.
  const existingPermission = (config.permission ?? {}) as NonNullable<OpencodeConfig['permission']>;
  const existingBash = (existingPermission.bash ?? {}) as Record<string, 'allow' | 'ask' | 'deny'>;
  const mergedBash: Record<string, 'allow' | 'ask' | 'deny'> = { ...OPENCODE_SAFE_BASH };
  // User's settings win over our defaults — preserves explicit deny rules etc.
  for (const [pattern, mode] of Object.entries(existingBash)) {
    mergedBash[pattern] = mode;
  }
  const bashChanged = JSON.stringify(existingBash) !== JSON.stringify(mergedBash);

  if (existingBinMatches && !bashChanged) {
    return {
      added: [],
      alreadyPresent: ['mcp.chorus', 'permission.bash'],
      configPath: OPENCODE_USER_CONFIG_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  mcp.chorus = {
    type: 'local',
    command: ['node', opts.binPath, 'mcp'],
    environment: { CHORUS_DAEMON_URL: daemonUrl },
    enabled: true,
  };

  const next: OpencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    ...config,
    mcp,
    permission: {
      ...existingPermission,
      bash: mergedBash,
    },
  };

  fs.mkdirSync(path.dirname(OPENCODE_USER_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(OPENCODE_USER_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');

  const added: string[] = [];
  if (!existingBinMatches) added.push('mcp.chorus');
  if (bashChanged) added.push('permission.bash');

  return {
    added,
    alreadyPresent: [],
    configPath: OPENCODE_USER_CONFIG_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

// ─── Kimi CLI (MoonshotAI) ──────────────────────────────────────────────────

const KIMI_CONFIG_DIR = path.join(os.homedir(), '.kimi');
const KIMI_MCP_PATH = path.join(KIMI_CONFIG_DIR, 'mcp.json');

function getKimiStatus(): OrchestratorStatus {
  const detected = fs.existsSync(KIMI_CONFIG_DIR);
  const connected = detected && hasKimiMcpServer();
  return {
    name: 'kimi',
    label: 'Kimi CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus as an MCP server in ~/.kimi/mcp.json. Kimi may show a one-time prompt before the first tool call — click Always allow.',
    supported: detected,
    firstCallBehavior: 'prompts_once',
  };
}

function hasKimiMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(KIMI_MCP_PATH)) return false;
  try {
    const body = JSON.parse(fs.readFileSync(KIMI_MCP_PATH, 'utf-8')) as Record<string, unknown>;
    const servers = body.mcpServers as Record<string, unknown> | undefined;
    const chorus = servers?.chorus as { args?: string[] } | undefined;
    if (!chorus) return false;
    if (!expectedBinPath) return true;
    return Array.isArray(chorus.args) && chorus.args.includes(expectedBinPath);
  } catch {
    return false;
  }
}

/**
 * Register Chorus with Kimi CLI via `kimi mcp add`. Same JSON shape as Gemini
 * (mcpServers.<name>) but stored in ~/.kimi/mcp.json.
 *
 * Idempotent + path-aware: re-registers if binPath drifted.
 */
export function connectKimi(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  if (hasKimiMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: KIMI_MCP_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  if (hasKimiMcpServer()) {
    try {
      execFileSync('kimi', ['mcp', 'remove', 'chorus'], { stdio: 'pipe' });
    } catch {
      // best-effort
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    execFileSync(
      'kimi',
      [
        'mcp', 'add',
        '--transport', 'stdio',
        'chorus',
        '-e', `CHORUS_DAEMON_URL=${daemonUrl}`,
        '--', 'node', opts.binPath, 'mcp',
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`kimi mcp add failed: ${msg}`);
  }

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: KIMI_MCP_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

// ─── Cursor + Windsurf (IDE forks of VSCode) ───────────────────────────────
//
// Both store MCP servers in a JSON file with the same { mcpServers: { ... } }
// shape as Gemini/Kimi. Neither ships an `mcp add` CLI — direct JSON edit.
// Detection looks for the config dir (Cursor/Windsurf is installed) but the
// mcp.json itself usually doesn't exist until first registration.

const CURSOR_CONFIG_DIR = path.join(os.homedir(), '.cursor');
const CURSOR_MCP_PATH = path.join(CURSOR_CONFIG_DIR, 'mcp.json');

const WINDSURF_CONFIG_DIR = path.join(os.homedir(), '.codeium', 'windsurf');
const WINDSURF_MCP_PATH = path.join(WINDSURF_CONFIG_DIR, 'mcp_config.json');

interface McpJsonShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJsonOrEmpty(filePath: string): McpJsonShape {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as McpJsonShape;
  } catch {
    return {};
  }
}

function hasMcpEntry(filePath: string, expectedBinPath?: string): boolean {
  const cfg = readJsonOrEmpty(filePath);
  const chorus = (cfg.mcpServers as Record<string, { args?: string[] }> | undefined)?.chorus;
  if (!chorus) return false;
  if (!expectedBinPath) return true;
  return Array.isArray(chorus.args) && chorus.args.includes(expectedBinPath);
}

function writeMcpEntry(opts: {
  filePath: string;
  binPath: string;
  daemonUrl: string;
}): void {
  const cfg = readJsonOrEmpty(opts.filePath);
  const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
  servers.chorus = {
    command: 'node',
    args: [opts.binPath, 'mcp'],
    env: { CHORUS_DAEMON_URL: opts.daemonUrl },
  };
  const next: McpJsonShape = { ...cfg, mcpServers: servers };
  fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
  fs.writeFileSync(opts.filePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

function getCursorStatus(): OrchestratorStatus {
  const detected = fs.existsSync(CURSOR_CONFIG_DIR);
  const connected = detected && hasMcpEntry(CURSOR_MCP_PATH);
  return {
    name: 'cursor',
    label: 'Cursor',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus in ~/.cursor/mcp.json. Cursor will prompt on first tool call — choose "Always allow" to make it stick.',
    supported: detected,
    firstCallBehavior: 'prompts_once',
  };
}

export function connectCursor(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  if (hasMcpEntry(CURSOR_MCP_PATH, opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: CURSOR_MCP_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  writeMcpEntry({
    filePath: CURSOR_MCP_PATH,
    binPath: opts.binPath,
    daemonUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL,
  });

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: CURSOR_MCP_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

function getWindsurfStatus(): OrchestratorStatus {
  const detected = fs.existsSync(WINDSURF_CONFIG_DIR);
  const connected = detected && hasMcpEntry(WINDSURF_MCP_PATH);
  return {
    name: 'windsurf',
    label: 'Windsurf',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus in ~/.codeium/windsurf/mcp_config.json. Windsurf will prompt on first tool call — choose "Always allow".',
    supported: detected,
    firstCallBehavior: 'prompts_once',
  };
}

export function connectWindsurf(opts: { binPath: string; daemonUrl?: string }): ConnectResult {
  if (hasMcpEntry(WINDSURF_MCP_PATH, opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: WINDSURF_MCP_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  writeMcpEntry({
    filePath: WINDSURF_MCP_PATH,
    binPath: opts.binPath,
    daemonUrl: opts.daemonUrl ?? DEFAULT_DAEMON_URL,
  });

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: WINDSURF_MCP_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export function connectByName(
  name: string,
  opts: { binPath: string; daemonUrl?: string } = { binPath: '' },
): ConnectResult {
  switch (name) {
    case 'claude':
      return connectClaude();
    case 'codex':
      return connectCodex(opts);
    case 'gemini':
      return connectGemini(opts);
    case 'opencode':
      return connectOpencode(opts);
    case 'kimi':
      return connectKimi(opts);
    case 'cursor':
      return connectCursor(opts);
    case 'windsurf':
      return connectWindsurf(opts);
    default:
      throw new Error(`Unknown orchestrator '${name}'.`);
  }
}

/**
 * Register Chorus as an MCP server in Claude Code's project config.
 * Patches `~/.claude.json` → projects.<projectDir>.mcpServers.chorus.
 *
 * Idempotent: if chorus is already pointing at the same bin path, returns
 * `{ added: false }`.
 */
export function registerClaudeMcpServer(opts: {
  binPath: string;
  projectDir?: string;
  daemonUrl?: string;
}): { added: boolean; configPath: string; project: string } {
  const configPath = path.join(os.homedir(), '.claude.json');
  const project = opts.projectDir ?? os.homedir();

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      throw new Error(
        `Could not parse ${configPath}. Fix the JSON or remove it and re-run.`,
      );
    }
  }

  const projects = (config.projects && typeof config.projects === 'object'
    ? (config.projects as Record<string, Record<string, unknown>>)
    : {});
  const projectBlock = projects[project] ?? {};
  const mcpServers = (projectBlock.mcpServers && typeof projectBlock.mcpServers === 'object'
    ? (projectBlock.mcpServers as Record<string, unknown>)
    : {});

  const existing = mcpServers.chorus as
    | { command?: string; args?: string[]; env?: Record<string, string> }
    | undefined;
  if (
    existing &&
    Array.isArray(existing.args) &&
    existing.args[0] === opts.binPath &&
    existing.args[1] === 'mcp'
  ) {
    return { added: false, configPath, project };
  }

  mcpServers.chorus = {
    command: 'node',
    args: [opts.binPath, 'mcp'],
    env: { CHORUS_DAEMON_URL: opts.daemonUrl ?? 'http://127.0.0.1:7707' },
  };

  projects[project] = { ...projectBlock, mcpServers };
  fs.writeFileSync(configPath, JSON.stringify({ ...config, projects }, null, 2), 'utf-8');
  return { added: true, configPath, project };
}

// ─── Auto-connect: detect all supported CLIs, wire each one ─────────────────

export interface AutoConnectStep {
  name: OrchestratorName;
  label: string;
  /** Was this CLI's config file present on disk? */
  detected: boolean;
  /** Did we add a new MCP server entry? (false if already registered) */
  registered: boolean;
  /** How many tools were added to the allow-list (0 if all were already there) */
  toolsAdded: number;
  /** State of the `/chorus` slash command for this CLI (claude only for v0.5) */
  slashCommand?: ConnectResult['slashCommand'];
  /** True if the CLI was detected but Chorus doesn't know how to wire it yet */
  unsupported?: boolean;
  /** Surfaced when something failed */
  error?: string;
}

export interface AutoConnectResult {
  steps: AutoConnectStep[];
  /** Did we touch at least one CLI? */
  anyConnected: boolean;
}

interface OrchestratorDetect {
  name: OrchestratorName;
  label: string;
  detect: () => boolean;
  connect: (opts: { binPath: string; projectDir?: string; daemonUrl?: string }) => {
    registered: boolean;
    toolsAdded: number;
    slashCommand?: ConnectResult['slashCommand'];
  };
}

const ORCHESTRATOR_DEFS: OrchestratorDetect[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude.json')),
    connect: (opts) => {
      const reg = registerClaudeMcpServer(opts);
      const conn = connectClaude();
      return {
        registered: reg.added,
        toolsAdded: conn.added.length,
        slashCommand: conn.slashCommand,
      };
    },
  },
  {
    name: 'codex',
    label: 'Codex CLI',
    detect: () => fs.existsSync(CODEX_CONFIG_PATH),
    connect: (opts) => {
      const before = hasCodexMcpServer();
      connectCodex(opts);
      return { registered: !before, toolsAdded: 0 };
    },
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    detect: () => fs.existsSync(GEMINI_SETTINGS_PATH),
    connect: (opts) => {
      const before = hasGeminiMcpServer();
      connectGemini(opts);
      return { registered: !before, toolsAdded: 0 };
    },
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    detect: () =>
      fs.existsSync(path.dirname(OPENCODE_USER_CONFIG_PATH)) ||
      fs.existsSync(path.join(os.homedir(), '.opencode')),
    connect: (opts) => {
      const result = connectOpencode(opts);
      return { registered: result.added.length > 0, toolsAdded: 0 };
    },
  },
  {
    name: 'kimi',
    label: 'Kimi CLI',
    detect: () => fs.existsSync(KIMI_CONFIG_DIR),
    connect: (opts) => {
      const before = hasKimiMcpServer(opts.binPath);
      connectKimi(opts);
      return { registered: !before, toolsAdded: 0 };
    },
  },
  {
    name: 'cursor',
    label: 'Cursor',
    detect: () => fs.existsSync(CURSOR_CONFIG_DIR),
    connect: (opts) => {
      const before = hasMcpEntry(CURSOR_MCP_PATH, opts.binPath);
      connectCursor(opts);
      return { registered: !before, toolsAdded: 0 };
    },
  },
  {
    name: 'windsurf',
    label: 'Windsurf',
    detect: () => fs.existsSync(WINDSURF_CONFIG_DIR),
    connect: (opts) => {
      const before = hasMcpEntry(WINDSURF_MCP_PATH, opts.binPath);
      connectWindsurf(opts);
      return { registered: !before, toolsAdded: 0 };
    },
  },
];

/**
 * Detect every CLI we know about and connect to all that are present.
 * Pass `only` to limit to a subset (e.g. ['claude', 'gemini']).
 */
export function autoConnectAll(opts: {
  binPath: string;
  projectDir?: string;
  daemonUrl?: string;
  only?: OrchestratorName[];
}): AutoConnectResult {
  const steps: AutoConnectStep[] = [];
  const allowed = opts.only ? new Set(opts.only) : null;

  for (const def of ORCHESTRATOR_DEFS) {
    if (allowed && !allowed.has(def.name)) continue;

    if (!def.detect()) {
      steps.push({
        name: def.name,
        label: def.label,
        detected: false,
        registered: false,
        toolsAdded: 0,
      });
      continue;
    }

    try {
      const result = def.connect(opts);
      steps.push({
        name: def.name,
        label: def.label,
        detected: true,
        registered: result.registered,
        toolsAdded: result.toolsAdded,
        slashCommand: result.slashCommand,
      });
    } catch (err) {
      steps.push({
        name: def.name,
        label: def.label,
        detected: true,
        registered: false,
        toolsAdded: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyConnected = steps.some((s) => s.detected && !s.unsupported && !s.error);
  return { steps, anyConnected };
}

/** Just detect — no writes. Used by `chorus init` to ask the user which to wire. */
export function detectOrchestrators(): { name: OrchestratorName; label: string; detected: boolean }[] {
  return ORCHESTRATOR_DEFS.map((def) => ({
    name: def.name,
    label: def.label,
    detected: def.detect(),
  }));
}
