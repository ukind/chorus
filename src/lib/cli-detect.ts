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
 * Verify a binary is runnable by invoking `--version` with a short timeout.
 * Returns true if the binary exits 0 within the timeout, false otherwise.
 *
 * Some CLIs print version on stderr or use `version` instead of `--version`,
 * so we treat any exit code 0 as success without inspecting output.
 */
function verifyRunnable(binPath: string, timeoutMs = 2000): boolean {
  if (!existsSync(binPath)) return false;
  try {
    const result = spawnSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      // Suppress any interactive prompts that might block.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function detectOne(cli: DetectableCli): CliDetection {
  // 1. PATH lookup
  const onPath = pathLookup(BINARY_NAME[cli]);
  if (onPath && verifyRunnable(onPath)) {
    return { id: cli, found: true, path: onPath, source: 'path' };
  }

  // 2. Fallback known dirs
  for (const candidate of fallbackPaths(cli)) {
    if (existsSync(candidate) && verifyRunnable(candidate)) {
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
 */
export function validateCliPath(cli: DetectableCli, customPath: string): CliDetection {
  const trimmed = customPath.trim();
  if (!trimmed) return { id: cli, found: false };
  if (!existsSync(trimmed)) return { id: cli, found: false };
  if (!verifyRunnable(trimmed)) return { id: cli, found: false };
  return { id: cli, found: true, path: trimmed, source: 'manual' };
}
