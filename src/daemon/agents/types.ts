// Agent shim interface — every CLI lineage implements this.
// Pattern ported from openbridge's lib/agents/<name>.sh; see
// /home/ubuntu/.claude/projects/-home-ubuntu/memory/openbridge_architecture.md

export type Lineage = 'anthropic' | 'openai' | 'google' | 'xai' | 'any';

/**
 * Transport-aware sandbox modes (Codex CLI relevant; others ignore).
 * - folder: writes only inside cwd, network blocked (strictest, default)
 * - github: workspace-write + network (gh CLI calls work)
 * - tmux: workspace-write, no network (live pane only, no persistence)
 */
export type Transport = 'folder' | 'github' | 'tmux';

export interface AgentSpawnOptions {
  /** Stable id like `chat-<chatId>-<phaseId>-<role>-<agentName>`. */
  sessionName: string;
  /** Working directory the CLI launches in. */
  cwd: string;
  /** Folder/github/tmux. Default `folder`. */
  transport?: Transport;
  /** Specific model (e.g. `claude-opus-4-7`); empty = CLI default. */
  model?: string;
  /** Pre-approved sandbox bypass for this session. Default false. */
  unsandboxed?: boolean;
  /** Used for per-account isolation (codex multi-auth). */
  accountId?: string;
}

export interface AgentNudgeOptions {
  /**
   * Absolute path to a file the agent should read before responding.
   * The CLI shim formats this path appropriately:
   *   - Gemini: `@/abs/path` inline syntax
   *   - Opencode: plain "at /abs/path" (no `/` or `@` prefix)
   *   - Claude/Codex: any reference works
   */
  promptFile: string;
  /**
   * Absolute path the agent should write its answer to. Communicated in the
   * prompt body; the daemon's output watcher polls for this file.
   */
  answerFile: string;
  /**
   * One-line summary that becomes the prompt's first line. Per-CLI formatting
   * (single-line vs multi-paragraph) is handled by the shim.
   */
  task: string;
  /**
   * Mark the prompt with `## DONE` sentinel so the watcher knows the agent
   * has flushed its full answer (some CLIs stream their output).
   */
  expectDoneSentinel?: boolean;
}

/**
 * One implementation per CLI lineage.
 * Lives at src/daemon/agents/<name>.ts and registered in src/daemon/agents/index.ts.
 */
export interface AgentShim {
  /** Lineage tag this shim handles. */
  readonly lineage: Lineage;
  /** Stable name for logs / agent picker. */
  readonly name: string;
  /**
   * Build the shell command that launches this CLI. Returned string is fed to
   * `tmux new-session -d -s <name> "<launch>"`. Caller is responsible for %q
   * quoting any user-supplied values BEFORE they reach this function — this
   * function only adds CLI-specific flags.
   */
  buildLaunchCommand(opts: AgentSpawnOptions): string;
  /**
   * Format the prompt text for THIS CLI's TUI. Must return a string safe to
   * paste via `tmux load-buffer / paste-buffer`. Per-CLI rules:
   *   - Gemini: single line, `@/abs/path`
   *   - Opencode: single line, "at /abs/path", never leads with `/` or `@`
   *   - Claude/Codex: multi-paragraph fine
   */
  formatPrompt(opts: AgentNudgeOptions): string;
  /**
   * Pre-nudge cleanup the CLI's TUI may need (dismiss overlays, send /clear,
   * etc.). Synchronous tmux send-keys calls only — no awaits.
   * Default: noop.
   */
  preNudge?(sessionName: string): void;
  /**
   * Optional tmux send-keys sequence for pre-nudge setup (e.g., /clear for opencode).
   * Array of key names like ['Escape', '/clear', 'Enter'].
   * The runner invokes `mgr.sendKeys(...)` with these in sequence.
   */
  readonly clearKeys?: readonly string[];
  /**
   * Estimate per-call cost in USD. Used by /new cost preview. CLI-subscription
   * lineages return 0; API-keyed lineages use the rate card. Best-effort.
   */
  estimateCostUsd(inputTokens: number, outputTokens: number, model?: string): number;
}

/**
 * Registry: lineage → shim. See src/daemon/agents/index.ts.
 */
export interface AgentRegistry {
  pickShim(lineage: Lineage, model?: string): AgentShim;
  listAvailable(): AgentShim[];
}
