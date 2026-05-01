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
 * Per-CLI fallback install locations to probe when PATH lookup misses.
 * Paths use the actual binary name (with .exe/.cmd on Windows where applicable).
 */
function fallbackPaths(cli: DetectableCli): string[] {
  const bin = BINARY_NAME[cli];
  const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
  const dirs: string[] = [];

  if (isWindows) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
    dirs.push(path.join(HOME, 'AppData', 'Roaming', 'npm'));
  } else {
    dirs.push(
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      path.join(HOME, '.bun', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
    );
  }

  // CLI-specific installer locations
  if (cli === 'opencode-cli') {
    dirs.push(path.join(HOME, '.opencode', 'bin'));
  }
  if (cli === 'kimi-cli') {
    dirs.push(path.join(HOME, '.kimi', 'bin'));
  }

  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      candidates.push(path.join(dir, `${bin}${ext}`));
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
