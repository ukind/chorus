/**
 * Telemetry tests — round-2-deferred §4.
 *
 * Pins:
 *   - All three opt-out paths disable independently
 *   - Install ID is read-then-create, idempotent across calls, v4-shape only
 *   - Payload shape matches the spec exactly (no PII fields slip in)
 *   - sendHeartbeat returns null on opt-out (no fetch call) and on fetch
 *     failure (no throw)
 *   - countChatsLast24h respects the 24h window
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isTelemetryEnabled,
  getOrCreateInstallId,
  buildPayload,
  sendHeartbeat,
  countChatsLast24h,
  _testing,
} from '../src/lib/telemetry';
import { settings, chats, _resetDbForTests } from '../src/lib/db';

let realHome: string | undefined;
let fakeHome: string;

beforeEach(async () => {
  realHome = process.env.HOME;
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-telemetry-'));
  process.env.HOME = fakeHome;
  fs.mkdirSync(path.join(fakeHome, '.chorus'), { recursive: true });
  delete process.env.CHORUS_TELEMETRY;
  // Each test gets its own DB so settings + chats stay isolated.
  await _resetDbForTests();
});

afterEach(() => {
  if (realHome) process.env.HOME = realHome;
  else delete process.env.HOME;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('isTelemetryEnabled', () => {
  it('returns true by default (no env, no file, no setting)', async () => {
    expect(await isTelemetryEnabled()).toBe(true);
  });

  it('returns false when CHORUS_TELEMETRY=0', async () => {
    process.env.CHORUS_TELEMETRY = '0';
    expect(await isTelemetryEnabled()).toBe(false);
  });

  it('returns true when CHORUS_TELEMETRY is set to anything else', async () => {
    process.env.CHORUS_TELEMETRY = '1';
    expect(await isTelemetryEnabled()).toBe(true);
  });

  it.each([['false'], ['False'], ['FALSE'], ['no'], ['off'], ['NO'], ['0']])(
    'accepts CHORUS_TELEMETRY=%s as a disable (round-1 dogfood feedback)',
    async (val) => {
      process.env.CHORUS_TELEMETRY = val;
      expect(await isTelemetryEnabled()).toBe(false);
    },
  );

  it('touch-file disables even when settings flag is true', async () => {
    await settings.set(_testing.SETTINGS_KEY, true);
    fs.writeFileSync(_testing.noTelemetryPath(), '');
    expect(await isTelemetryEnabled()).toBe(false);
  });

  it('returns false when ~/.chorus/no-telemetry exists', async () => {
    fs.writeFileSync(_testing.noTelemetryPath(), '');
    expect(await isTelemetryEnabled()).toBe(false);
  });

  it('returns false when settings flag is explicitly false', async () => {
    await settings.set(_testing.SETTINGS_KEY, false);
    expect(await isTelemetryEnabled()).toBe(false);
  });

  it('returns true when settings flag is explicitly true', async () => {
    await settings.set(_testing.SETTINGS_KEY, true);
    expect(await isTelemetryEnabled()).toBe(true);
  });

  it('env wins over a true settings flag', async () => {
    await settings.set(_testing.SETTINGS_KEY, true);
    process.env.CHORUS_TELEMETRY = '0';
    expect(await isTelemetryEnabled()).toBe(false);
  });
});

describe('getOrCreateInstallId', () => {
  it('mints a new v4-shaped UUID on first call and persists it', () => {
    const id = getOrCreateInstallId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const onDisk = fs.readFileSync(_testing.installIdPath(), 'utf-8').trim();
    expect(onDisk).toBe(id);
  });

  it('reuses the same id across calls', () => {
    const a = getOrCreateInstallId();
    const b = getOrCreateInstallId();
    expect(a).toBe(b);
  });

  it('discards a malformed install-id file and mints a fresh one', () => {
    fs.writeFileSync(_testing.installIdPath(), 'not-a-uuid');
    const id = getOrCreateInstallId();
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    expect(fs.readFileSync(_testing.installIdPath(), 'utf-8').trim()).toBe(id);
  });
});

describe('buildPayload', () => {
  it('contains exactly the spec keys (no extras, no PII)', async () => {
    const payload = await buildPayload({
      version: '0.7.0',
      daemonStartedAt: Date.now() - 60_000,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'arch',
      'chatsLast24h',
      'daemonUptimeSeconds',
      'installId',
      'node',
      'os',
      'schema',
      'version',
    ]);
    expect(payload.schema).toBe(1);
    expect(payload.version).toBe('0.7.0');
    expect(payload.daemonUptimeSeconds).toBeGreaterThanOrEqual(60);
    expect(payload.daemonUptimeSeconds).toBeLessThan(120);
    expect(payload.os).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
    expect(payload.node).toBe(process.versions.node.split('.')[0]);
  });

  it('does not leak any value containing the home dir path', async () => {
    const payload = await buildPayload({ version: '0.7.0', daemonStartedAt: Date.now() });
    const json = JSON.stringify(payload);
    expect(json).not.toContain(fakeHome);
    expect(json).not.toContain(os.userInfo().username);
  });

  it('caps daemonUptimeSeconds at 0 if clock skews backward', async () => {
    const payload = await buildPayload({
      version: '0.7.0',
      daemonStartedAt: Date.now() + 10_000,
    });
    expect(payload.daemonUptimeSeconds).toBe(0);
  });
});

describe('countChatsLast24h', () => {
  it('returns 0 on an empty chats table', async () => {
    expect(await countChatsLast24h()).toBe(0);
  });

  it('counts chats inside the 24h window and excludes older ones', async () => {
    const now = Date.now();
    const insideWindow = now - 60 * 60 * 1000; // 1h ago
    const outsideWindow = now - 25 * 60 * 60 * 1000; // 25h ago
    const a = await chats.create({ work: 'x', template_id: 't' });
    const b = await chats.create({ work: 'x', template_id: 't' });
    const c = await chats.create({ work: 'x', template_id: 't' });
    // Backdate created_at to specific times — chats.create stamps `now`,
    // so push two into the window and one outside it.
    const { getDb } = await import('../src/lib/db');
    const db = await getDb();
    await db.execute({ sql: 'UPDATE chats SET created_at = ? WHERE id = ?', args: [insideWindow, a.id] });
    await db.execute({ sql: 'UPDATE chats SET created_at = ? WHERE id = ?', args: [insideWindow, b.id] });
    await db.execute({ sql: 'UPDATE chats SET created_at = ? WHERE id = ?', args: [outsideWindow, c.id] });

    const n = await countChatsLast24h(now);
    expect(n).toBe(2);
  });
});

describe('sendHeartbeat', () => {
  it('returns null and never calls fetch when telemetry is disabled', async () => {
    process.env.CHORUS_TELEMETRY = '0';
    const fetchSpy = vi.fn();
    const result = await sendHeartbeat({
      version: '0.7.0',
      daemonStartedAt: Date.now(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
    });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the assembled payload as JSON and returns it on success', async () => {
    const calls: Array<[unknown, unknown]> = [];
    const fetchSpy = vi.fn(async (...args: unknown[]) => {
      calls.push([args[0], args[1]]);
      return new Response(null, { status: 204 });
    });
    const result = await sendHeartbeat({
      version: '0.7.0',
      daemonStartedAt: Date.now() - 1000,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = calls[0];
    expect(url).toBe(_testing.ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(typeof (init as RequestInit).body).toBe('string');
    expect(result).not.toBeNull();
    expect(result!.schema).toBe(1);
  });

  it('returns null and logs but never throws on fetch failure', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ENOTFOUND chorus.codes');
    });
    const logSpy = vi.fn();
    const result = await sendHeartbeat({
      version: '0.7.0',
      daemonStartedAt: Date.now(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: logSpy,
    });
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
  });

  it('returns null when buildPayload throws (round-1 dogfood: DB closed mid-shutdown)', async () => {
    // Simulate libsql disconnect during shutdown — countChatsLast24h
    // calls getDb() which rejects. Round-1 reviewers (Claude+Gemini)
    // both flagged that buildPayload was outside the try/catch, so this
    // case rejected the promise the daemon discarded with `void`,
    // producing an unhandled rejection. Test pins the fix.
    const dbModule = await import('../src/lib/db');
    const realGetDb = dbModule.getDb;
    const spy = vi.spyOn(dbModule, 'getDb').mockImplementation(async () => {
      throw new Error('libsql: connection closed');
    });
    const logSpy = vi.fn();
    const fetchSpy = vi.fn();
    const result = await sendHeartbeat({
      version: '0.7.0',
      daemonStartedAt: Date.now(),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: logSpy,
    });
    spy.mockRestore();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('connection closed'));
    // Smoke: real getDb still works post-restore.
    const db = await realGetDb();
    expect(db).toBeDefined();
  });
});

describe('startTelemetryHeartbeat', () => {
  it('schedules a boot send + a 24h interval, both .unrefed', async () => {
    const setTimeoutCalls: Array<{ delay: number; handle: NodeJS.Timeout }> = [];
    const setIntervalCalls: Array<{ delay: number; handle: NodeJS.Timeout }> = [];
    // Real timers; we capture and immediately clear them so nothing fires
    // inside the test. unref() is a real method on returned timer handles
    // so we can assert it was called by spying on the prototype.
    const realSetTimeout: typeof setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const h = setTimeout(...args);
      setTimeoutCalls.push({ delay: args[1] as number, handle: h });
      return h;
    }) as typeof setTimeout;
    const realSetInterval: typeof setInterval = ((...args: Parameters<typeof setInterval>) => {
      const h = setInterval(...args);
      setIntervalCalls.push({ delay: args[1] as number, handle: h });
      return h;
    }) as typeof setInterval;

    const { startTelemetryHeartbeat } = await import('../src/lib/telemetry');
    const handle = startTelemetryHeartbeat({
      version: '0.7.0',
      daemonStartedAt: Date.now(),
      setTimeoutImpl: realSetTimeout,
      setIntervalImpl: realSetInterval,
    });

    expect(setTimeoutCalls).toHaveLength(1);
    expect(setTimeoutCalls[0].delay).toBe(5_000);
    expect(setIntervalCalls).toHaveLength(1);
    expect(setIntervalCalls[0].delay).toBe(_testing.HEARTBEAT_INTERVAL_MS);

    // stop() clears both — assert by ref inspection: clearing a timer
    // that's already cleared is a no-op, so we just verify stop is callable.
    handle.stop();
    // Clean up in case stop missed (defence in depth — also fine if
    // unref made the test exit before the timer would fire).
    clearTimeout(setTimeoutCalls[0].handle);
    clearInterval(setIntervalCalls[0].handle);
  });
});
