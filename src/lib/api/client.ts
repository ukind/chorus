// Fetch wrapper with error handling and base URL management
import { ApiResponse } from "@/lib/types";

// Server-side: hit the daemon directly on this host.
// Browser-side: go through the Next.js proxy at /api/daemon (the browser
// cannot reach 127.0.0.1 on the server).
//
// Server-side base URL discovery uses the same daemon.json-first
// resolution as the proxy route (see lib/daemon-discovery.ts). Pre-fix,
// SERVER_BASE was a module-load-time snapshot of process.env that
// fell through to 127.0.0.1:7707 on miss — which broke whenever the
// daemon shifted ports (VSCode squat in WSL, etc). Now we re-resolve
// on first call per process, cache the result, and invalidate on a
// connection failure so a daemon that comes up on a new port is
// picked up by the next request.
//
// daemon-discovery is dynamically imported only on the server because
// it pulls in node:path/fs/os which webpack cannot bundle for the
// browser. The browser path never hits that branch.
const CLIENT_BASE = "/api/daemon";
const API_PREFIX = "/api/v1";

let cachedServerBase: string | null = null;

/**
 * Read daemon.json directly using a synchronous runtime require so
 * webpack does not pull node:fs / node:path / node:os into the browser
 * bundle. lib/api/client is imported from both server components and
 * "use client" components; at runtime this function only runs when
 * typeof window === undefined, but webpack walks static import graphs
 * regardless of runtime checks.
 *
 * eval('require') is the standard escape hatch for "I need Node modules
 * but only on the server, and webpack must not analyze this." In an
 * ESM context (Next.js server bundles) require() isn't defined, so we
 * fall back to createRequire.
 */
function readDaemonJsonSync(): { daemonPort: number } | null {
  try {
    // Resolve a CommonJS-style require even in ESM contexts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynRequire =
      typeof (globalThis as any).require === "function"
        ? (globalThis as any).require
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        : (eval("require") as NodeJS.Require | undefined);
    if (!dynRequire) return null;
    const fs = dynRequire("node:fs") as typeof import("node:fs");
    const path = dynRequire("node:path") as typeof import("node:path");
    const os = dynRequire("node:os") as typeof import("node:os");
    const target = path.join(os.homedir(), ".chorus", "daemon.json");
    const raw = fs.readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw) as { schemaVersion?: number; daemonPort?: number };
    if (parsed.schemaVersion !== 1 || typeof parsed.daemonPort !== "number") {
      return null;
    }
    return { daemonPort: parsed.daemonPort };
  } catch {
    return null;
  }
}

async function getServerBase(): Promise<string> {
  if (cachedServerBase) return cachedServerBase;
  // 1. daemon.json wins — the source of truth written by `chorus start`
  //    after it picks free ports.
  const info = readDaemonJsonSync();
  if (info) {
    cachedServerBase = `http://127.0.0.1:${info.daemonPort}`;
    return cachedServerBase;
  }
  // 2. CHORUS_DAEMON_URL env override (remote daemon use case + the
  //    legacy v0.7 path where chorus start passed this env in).
  if (process.env.CHORUS_DAEMON_URL) {
    cachedServerBase = process.env.CHORUS_DAEMON_URL;
    return cachedServerBase;
  }
  // 3. Hardcoded default for first-ever installs before daemon.json
  //    has been written.
  cachedServerBase = "http://127.0.0.1:7707";
  return cachedServerBase;
}

async function getBaseUrl(): Promise<string> {
  if (typeof window === "undefined") return await getServerBase();
  return new URL(CLIENT_BASE, window.location.origin).toString();
}

export class DaemonError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    /**
     * Optional structured payload mirrored from the server envelope's
     * `error.details`. Used for zod-issue lists from /templates POST so
     * the cockpit can pin each error to the field it references.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export async function fetchFromDaemon<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const base = await getBaseUrl();
  // Normalise to a leading-slash form first so the prefix check can
  // anchor on `/api/v1` exactly. Without this, `api/v1/foo` (no leading
  // slash) gets double-prefixed → `/api/v1/api/v1/foo`.
  const normalised = path.startsWith("/") ? path : `/${path}`;
  // Exact-segment match — naive `startsWith` would match `/api/v10/...`
  // or `/api/v1foo/...` and skip prepending.
  const isPrefixed =
    normalised === API_PREFIX || normalised.startsWith(`${API_PREFIX}/`);
  const versionedPath = isPrefixed ? normalised : `${API_PREFIX}${normalised}`;
  const url = `${base.replace(/\/$/, "")}${versionedPath}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const raw: unknown = await response.json().catch(() => ({
      ok: false,
      error: {
        code: "parse_error",
        message: "Failed to parse response",
      },
    }));
    const data = raw as ApiResponse<T>;

    if (!data.ok) {
      // Fastify's default 404/500 returns `{ statusCode, error: "<string>",
      // message }` — `error` is a STRING, not the chorus envelope's object.
      // Without this branch, `data.error?.message` is undefined and we'd
      // surface "Unknown error" instead of the actual reason.
      const fastifyShape = raw as {
        statusCode?: number;
        error?: unknown;
        message?: string;
      };
      const isFastifyError =
        typeof fastifyShape.error === "string" &&
        typeof fastifyShape.message === "string";
      if (isFastifyError) {
        throw new DaemonError(
          fastifyShape.error as string,
          response.status,
          fastifyShape.message as string,
        );
      }
      throw new DaemonError(
        data.error?.code || "unknown",
        response.status,
        data.error?.message || `Daemon returned ${response.status}`,
        data.error?.details,
      );
    }

    return data.data as T;
  } catch (error) {
    if (error instanceof DaemonError) {
      throw error;
    }

    if (error instanceof TypeError && error.message.includes("fetch")) {
      // Daemon may have shifted ports (or come up on a different port
      // than what we cached at module load). Invalidate so the next
      // call re-resolves from daemon.json.
      cachedServerBase = null;
      throw new DaemonError(
        "connection_failed",
        0,
        "Failed to connect to Chorus daemon. Is it running?",
      );
    }

    throw new DaemonError(
      "unknown",
      0,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
