/**
 * Opt-out telemetry heartbeat (round-2-deferred §4).
 *
 * Daemon-side ping to chorus.codes once per boot + once per 24h. The
 * payload is a fixed, audited shape — version, OS, arch, node major,
 * daemon uptime, count of chats in the last 24h. No chat content, no
 * file paths, no hostnames, no API keys.
 *
 * Three opt-out paths, any one disables:
 *   1. CHORUS_TELEMETRY=0 environment variable
 *   2. ~/.chorus/no-telemetry touch-file (matches cargo / brew convention)
 *   3. settings key `telemetry.enabled` set to false
 *
 * The endpoint may not exist yet — sends are fire-and-forget with a 5s
 * timeout; failure logs at debug level only and never blocks the daemon
 * or surfaces to the user. Schema-versioned (`schema: 1`) so future
 * payload changes are additive and old daemons keep working.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { settings, getDb } from './db/index.js';

export interface TelemetryPayload {
  schema: 1;
  installId: string;
  version: string;
  os: string;
  arch: string;
  node: string;
  daemonUptimeSeconds: number;
  chatsLast24h: number;
}

const ENDPOINT = 'https://chorus.codes/api/telemetry';
const SETTINGS_KEY = 'telemetry.enabled';
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;

function chorusDir(): string {
  return path.join(os.homedir(), '.chorus');
}

function installIdPath(): string {
  return path.join(chorusDir(), 'install-id');
}

function noTelemetryPath(): string {
  return path.join(chorusDir(), 'no-telemetry');
}

/** Common falsy strings users naturally type to mean "off". */
const ENV_DISABLE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Check all three opt-out paths. Returns false if any one disables.
 * Settings DB is consulted last so env / touch-file work even when the
 * DB hasn't been opened yet (e.g. first-boot probe).
 *
 * `CHORUS_TELEMETRY` accepts any of `0`/`false`/`no`/`off` (case
 * insensitive); anything else leaves telemetry enabled. The variable
 * is a soft kill switch, not a strict on/off enum.
 */
export async function isTelemetryEnabled(): Promise<boolean> {
  const env = process.env.CHORUS_TELEMETRY;
  if (env !== undefined && ENV_DISABLE_VALUES.has(env.toLowerCase())) return false;
  if (fs.existsSync(noTelemetryPath())) return false;
  try {
    const raw = await settings.get(SETTINGS_KEY);
    if (raw === false) return false;
  } catch {
    // DB not ready — assume enabled at the per-call level. The boot
    // wiring won't hit this path because it runs after seedSettings().
  }
  return true;
}

/**
 * Read or mint an anonymous install ID. Lives in `~/.chorus/install-id`
 * as a single line; user can `rm` it to reset (a new UUID is minted on
 * the next call). Not derived from anything machine-specific.
 */
export function getOrCreateInstallId(): string {
  const dir = chorusDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = installIdPath();
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    // Tolerate manual edits / partial writes — only accept UUID-shaped
    // strings (any version); anything else gets replaced with a fresh ID
    // rather than failing the heartbeat. randomUUID() emits v4, but the
    // shape check is intentionally version-agnostic so a hand-edited v7
    // installId from a downstream tool keeps working.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  }
  const fresh = randomUUID();
  // 0o600 — readable + writable only by the daemon's user. Belt-and-
  // braces against ID correlation across users on a shared host.
  fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  return fresh;
}

/**
 * Count chats created in the last 24 hours. Pure DB read; no chat
 * content, just a count of rows.
 */
export async function countChatsLast24h(now: number = Date.now()): Promise<number> {
  const cutoff = now - HEARTBEAT_INTERVAL_MS;
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM chats WHERE created_at >= ?',
    args: [cutoff],
  });
  const row = result.rows[0];
  if (!row) return 0;
  // libsql returns column values via row.n (object access) when columns
  // are aliased — index access is also valid. Be defensive across both.
  const raw = (row as Record<string, unknown>).n ?? (row as unknown as unknown[])[0];
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Assemble the payload. Pure shape — easy to test against the spec.
 * `version` is read from package.json so a stale literal can't drift;
 * caller supplies it (the daemon already imports its own version).
 */
export async function buildPayload(args: {
  version: string;
  daemonStartedAt: number;
  now?: number;
}): Promise<TelemetryPayload> {
  const now = args.now ?? Date.now();
  // Node 'major' only — minor/patch leak less-useful detail and bloat
  // the analytics cardinality.
  const nodeMajor = process.versions.node.split('.')[0];
  return {
    schema: 1,
    installId: getOrCreateInstallId(),
    version: args.version,
    os: process.platform,
    arch: process.arch,
    node: nodeMajor,
    daemonUptimeSeconds: Math.max(0, Math.floor((now - args.daemonStartedAt) / 1000)),
    chatsLast24h: await countChatsLast24h(now),
  };
}

/**
 * Fire-and-forget POST. Honours all three opt-out paths. Never throws —
 * a dead endpoint, DB error during `buildPayload`, fs error during
 * `getOrCreateInstallId`, or any other failure resolves to `null`
 * rather than rejecting. Returns the sent payload on success so tests
 * can assert exact bytes without scraping log lines.
 *
 * Round-1 dogfood (PR #6) caught a bug here: `buildPayload` ran
 * outside the try/catch, so a transient libsql disconnect during
 * shutdown rejected the promise the daemon discarded with `void`,
 * producing an unhandled rejection. The whole body is now wrapped.
 */
export async function sendHeartbeat(args: {
  version: string;
  daemonStartedAt: number;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to console.log("[telemetry] ..."). */
  log?: (msg: string) => void;
}): Promise<TelemetryPayload | null> {
  const log = args.log ?? ((m: string) => console.log(`[telemetry] ${m}`));
  try {
    if (!(await isTelemetryEnabled())) return null;

    const payload = await buildPayload({
      version: args.version,
      daemonStartedAt: args.daemonStartedAt,
    });

    const fetchFn = args.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Boot wiring — fires once now (after a small delay so the daemon is
 * definitely listening) and then every 24h. Returns the interval handle
 * so the daemon can clear it on shutdown.
 */
export function startTelemetryHeartbeat(args: {
  version: string;
  daemonStartedAt: number;
  /** Test seam — defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  /** Test seam — defaults to setTimeout. */
  setTimeoutImpl?: typeof setTimeout;
}): { stop: () => void } {
  const setIntervalFn = args.setIntervalImpl ?? setInterval;
  const setTimeoutFn = args.setTimeoutImpl ?? setTimeout;

  // Small delay on first send so the daemon is definitely up + the DB is
  // open. 5s is enough; the heartbeat itself has a 5s timeout.
  const bootHandle = setTimeoutFn(() => {
    void sendHeartbeat({ version: args.version, daemonStartedAt: args.daemonStartedAt });
  }, 5_000);

  const intervalHandle = setIntervalFn(() => {
    void sendHeartbeat({ version: args.version, daemonStartedAt: args.daemonStartedAt });
  }, HEARTBEAT_INTERVAL_MS);

  // Don't pin the event loop. If the daemon ever wants natural exit
  // (e.g. SIGTERM → fastify.close → drain pendings), telemetry timers
  // shouldn't keep it alive. The daemon also calls .stop() on signal,
  // so this is belt-and-braces.
  if (typeof (bootHandle as NodeJS.Timeout).unref === 'function') {
    (bootHandle as NodeJS.Timeout).unref();
  }
  if (typeof (intervalHandle as NodeJS.Timeout).unref === 'function') {
    (intervalHandle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => {
      clearTimeout(bootHandle as NodeJS.Timeout);
      clearInterval(intervalHandle as NodeJS.Timeout);
    },
  };
}

// Test-only seams. These are exported under a stable namespace so the
// test file can mutate paths without touching `~/.chorus` on the host.
export const _testing = {
  installIdPath,
  noTelemetryPath,
  chorusDir,
  ENDPOINT,
  SETTINGS_KEY,
  HEARTBEAT_INTERVAL_MS,
  SEND_TIMEOUT_MS,
};
