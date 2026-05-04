/**
 * Detect whether each supported CLI is installed and runnable.
 *
 * Layered probe:
 *   1. PATH lookup via `which` (Unix) / `where` (Windows)
 *   2. Fallback known install dirs per CLI (covers OpenCode/Kimi installers
 *      that drop binaries in non-PATH locations)
 *   3. Verify with `<bin> --version` (2s timeout) so dead symlinks fail
 *
 * Cursor and Windsurf are IDEs invoked via MCP, not CLIs on PATH, so they're
 * not part of this probe — onboarding leaves their checkboxes for the user.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import path from 'path';

export type DetectableCli =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'opencode-cli'
  | 'kimi-cli';

const BINARY_NAME: Record<DetectableCli, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'kimi-cli': 'kimi',
};

const isWindows = platform() === 'win32';
const HOME = homedir();

/**
 * Discovered npm prefix bin dirs — populated lazily by `discoverNpmPrefixes`.
 * Cached at module scope so we shell out once per daemon lifetime, not once
 * per CLI per probe.
 */
let cachedNpmDirs: string[] | null = null;

/**
 * Ask npm where it installs global binaries. Covers users with custom
 * `prefix` configs (e.g. ~/.npm-global, ~/.config/npm), nvm-active
 * versions, or an OS package manager that put npm in a non-default
 * location. Best-effort — a missing/broken npm just yields an empty
 * list so we fall back to the static probes.
 */
function discoverNpmPrefixes(): string[] {
  if (cachedNpmDirs !== null) return cachedNpmDirs;
  const dirs = new Set<string>();
  // Try `npm config get prefix` (1s budget — slow npm shouldn't block detect).
  try {
    const result = spawnSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      const prefix = result.stdout.trim();
      if (prefix) {
        dirs.add(isWindows ? prefix : path.join(prefix, 'bin'));
      }
    }
  } catch {
    /* npm not installed / not on PATH — fall through */
  }
  // NPM_CONFIG_PREFIX env override (common in CI, asdf, custom shells).
  const envPrefix = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix;
  if (envPrefix) {
    dirs.add(isWindows ? envPrefix : path.join(envPrefix, 'bin'));
  }
  cachedNpmDirs = Array.from(dirs);
  return cachedNpmDirs;
}

/**
 * Per-CLI fallback install locations to probe when PATH lookup misses.
 *
 * Covers the common installers in the wild — npm global with various
 * prefixes (default, custom, volta, fnm, nvm), Yarn, PNPM, Bun, Cargo,
 * Homebrew (Intel + Apple Silicon), system package dirs — plus per-CLI
 * installer-script locations (OpenCode + Kimi drop binaries in their
 * own dot-folders by default).
 *
 * Order matters: PATH lookup runs first; this list is the second-chance
 * scan, so cheap/common locations come first to keep the probe fast.
 */
function fallbackPaths(cli: DetectableCli): string[] {
  const bin = BINARY_NAME[cli];
  const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
  const dirs: string[] = [];

  if (isWindows) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) {
      dirs.push(
        path.join(process.env.LOCALAPPDATA, 'Programs'),
        // Volta on Windows
        path.join(process.env.LOCALAPPDATA, 'Volta', 'bin'),
      );
    }
    dirs.push(
      path.join(HOME, 'AppData', 'Roaming', 'npm'),
      path.join(HOME, '.volta', 'bin'),
      path.join(HOME, '.bun', 'bin'),
    );
  } else {
    dirs.push(
      // User-local
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.npm-global', 'bin'),
      path.join(HOME, '.config', 'yarn', 'global', 'node_modules', '.bin'),
      path.join(HOME, '.yarn', 'bin'),
      // Node version managers
      path.join(HOME, '.volta', 'bin'),
      path.join(HOME, '.fnm', 'aliases', 'default', 'bin'),
      // Alt package managers
      path.join(HOME, '.bun', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      path.join(HOME, '.local', 'share', 'pnpm'),
      path.join(HOME, 'Library', 'pnpm'),
      // System-wide
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      // Common npm-global system dirs
      '/usr/local/lib/node_modules/.bin',
      '/opt/homebrew/lib/node_modules/.bin',
    );
  }

  // CLI-specific installer locations (their own install scripts).
  if (cli === 'opencode-cli') {
    dirs.push(path.join(HOME, '.opencode', 'bin'));
  }
  if (cli === 'kimi-cli') {
    dirs.push(path.join(HOME, '.kimi', 'bin'));
  }

  // npm-discovered prefixes — cheapest signal for "where did the user
  // actually install global packages?". Pulled last so the static list
  // wins on cache hits, but still covers exotic setups.
  for (const npmDir of discoverNpmPrefixes()) {
    dirs.push(npmDir);
  }

  const candidates: string[] = [];
  // Dedup while preserving order — a user with PNPM_HOME=~/.local/share/pnpm
  // shouldn't pay for two probes of the same dir.
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `${bin}${ext}`);
      if (seen.has(full)) continue;
      seen.add(full);
      candidates.push(full);
    }
  }
  return candidates;
}

export interface CliDetection {
  id: DetectableCli;
  found: boolean;
  path?: string;
  /** "path" = found via PATH lookup, "fallback" = found via known dirs, "manual" = user-supplied */
  source?: 'path' | 'fallback' | 'manual';
  /** Populated when found=false on manual validation — explains why
   *  (e.g. "no file at that path", "doesn't look like the claude CLI"). */
  reason?: string;
}

function pathLookup(name: string): string | null {
  const cmd = isWindows ? 'where' : 'which';
  const result = spawnSync(cmd, [name], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  // `where` returns one path per line on Windows; take the first.
  const first = result.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return first || null;
}

/**
 * Per-CLI version-output signatures. The shape varies wildly between
 * CLIs — claude prints "2.1.126 (Claude Code)", codex prints
 * "codex-cli 0.128.0", but gemini / opencode print just a bare
 * version like "0.40.1" with NO CLI name. So each CLI gets its own
 * matcher rather than a uniform name-substring regex.
 *
 * Strategy:
 *   - CLIs whose output includes the name → match the name (case-insensitive).
 *   - CLIs that print a bare version → accept output that STARTS with a
 *     digit-dot-digit (semver-ish). This rules out e.g. `cat --version`
 *     (output starts with "cat (GNU…") while accepting any reasonable
 *     `<bin> --version` from a real install.
 *
 * False positives here (a runnable binary that happens to print a bare
 * version) are still better than rubber-stamping `cat --version` as a
 * valid Claude install — which is what the original exit-0-only check
 * did.
 */
const STARTS_WITH_VERSION = /^\s*\d+\.\d+/;
const CLI_SIGNATURES: Record<DetectableCli, RegExp> = {
  'claude-code': /\bclaude\b/i,
  'codex-cli': /\bcodex\b/i,
  // Bare version output — "0.40.1" — no CLI name to grep for.
  'gemini-cli': STARTS_WITH_VERSION,
  // Bare version output — "1.14.30" — same as gemini.
  'opencode-cli': STARTS_WITH_VERSION,
  'kimi-cli': /\bkimi\b/i,
};

interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function verifyRunnable(
  cli: DetectableCli,
  binPath: string,
  timeoutMs = 2000,
): VerifyResult {
  if (!existsSync(binPath)) {
    return { ok: false, reason: 'no file at that path' };
  }
  let result;
  try {
    result = spawnSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, reason: `failed to spawn (${(err as Error).message})` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `${path.basename(binPath)} --version exited ${result.status}`,
    };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const signature = CLI_SIGNATURES[cli];
  if (!signature.test(output)) {
    return {
      ok: false,
      reason:
        `that binary ran, but its --version output doesn't look like the ${BINARY_NAME[cli]} CLI`,
    };
  }
  return { ok: true };
}

function detectOne(cli: DetectableCli): CliDetection {
  // 1. PATH lookup
  const onPath = pathLookup(BINARY_NAME[cli]);
  if (onPath && verifyRunnable(cli, onPath).ok) {
    return { id: cli, found: true, path: onPath, source: 'path' };
  }

  // 2. Fallback known dirs
  for (const candidate of fallbackPaths(cli)) {
    if (existsSync(candidate) && verifyRunnable(cli, candidate).ok) {
      return { id: cli, found: true, path: candidate, source: 'fallback' };
    }
  }

  return { id: cli, found: false };
}

export function detectAllClis(): CliDetection[] {
  return (Object.keys(BINARY_NAME) as DetectableCli[]).map(detectOne);
}

/**
 * Validate a user-supplied path for a given CLI. Used by the
 * "Set path manually" fallback when auto-detect misses.
 *
 * Layered checks (any failure returns found=false + a reason):
 *   1. Basename matches the expected binary name. Catches the common
 *      paste-the-wrong-tool mistake — e.g. `/usr/bin/npm` for gemini-cli
 *      passes the bare-version regex but its basename is `npm`, not
 *      `gemini`. Both round-1 reviewers (claude + gemini) flagged this
 *      gap when smoke-testing the previous version.
 *   2. File exists.
 *   3. `--version` exits 0 with output that matches the CLI's signature.
 *
 * Auto-detect doesn't need step 1 — pathLookup/fallback already bound
 * the search to the expected binary name.
 */
export function validateCliPath(
  cli: DetectableCli,
  customPath: string,
): CliDetection & { reason?: string } {
  const trimmed = customPath.trim();
  if (!trimmed) return { id: cli, found: false, reason: 'path is empty' };
  // Basename gate — strip extension on Windows so claude.cmd / claude.exe
  // both match `claude`.
  const expectedBin = BINARY_NAME[cli];
  const actualBase = isWindows
    ? path.basename(trimmed).replace(/\.(cmd|exe)$/i, '')
    : path.basename(trimmed);
  if (actualBase.toLowerCase() !== expectedBin.toLowerCase()) {
    return {
      id: cli,
      found: false,
      reason: `that file is named "${actualBase}", but the ${cli} binary should be "${expectedBin}". Pasted the wrong path?`,
    };
  }
  if (!existsSync(trimmed))
    return { id: cli, found: false, reason: `no file at ${trimmed}` };
  const v = verifyRunnable(cli, trimmed);
  if (!v.ok) return { id: cli, found: false, reason: v.reason };
  return { id: cli, found: true, path: trimmed, source: 'manual' };
}
