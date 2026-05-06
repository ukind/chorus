// Fetch wrapper with error handling and base URL management
import { ApiResponse } from "@/lib/types";

// Both server-side and browser-side route through the Next.js proxy
// at /api/daemon. The proxy handler runs in nodejs runtime and has
// reliable access to ~/.chorus/daemon.json — no need to duplicate
// the discovery logic across runtimes (which broke historically).
//
// Browser side: relative URL works because the cockpit is the origin.
// Server side: needs absolute URL constructed from the request's host
// (via next/headers) — Next.js requires absolute URLs in fetch() when
// running outside the browser.
const CLIENT_BASE = "/api/daemon";
const API_PREFIX = "/api/v1";

/**
 * Server-side base URL — routes through the same `/api/daemon` proxy
 * the browser uses, via the request's own host. Why:
 *
 * Earlier attempts read daemon.json directly from inside the Next.js
 * server bundle. The eval('require') escape hatch worked locally but
 * failed in some Node 22 + Next.js production-server combinations
 * (likely ESM context where eval('require') ReferenceError-throws),
 * causing the SSR fetch to fall through to a 7707 default that hit
 * the VSCode tunnel squatter and hung for 5-10s before timing out
 * with "Daemon unreachable".
 *
 * Routing SSR through the proxy reuses the proxy's known-good
 * resolveDaemonUrl logic (which runs in the catch-all route's
 * nodejs runtime where fs/path/os are unambiguously available). The
 * cost is one extra HTTP hop through loopback — sub-millisecond on
 * any working setup, vastly better than the multi-second hang the
 * direct path was producing.
 *
 * No module-level cache: headers() is cheap, and the host can in
 * theory differ across requests in unusual deployments.
 */
async function getServerBase(): Promise<string> {
  try {
    // next/headers is async-import only inside a request scope. If
    // we're outside a request (e.g., a build-time prerender, although
    // pages set force-dynamic so this is rare), the import resolves
    // but the call throws — caught below.
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("host");
    if (host) {
      // Construct the cockpit's own origin and append /api/daemon.
      // The proxy auto-prefixes /api/v1 when needed, so callers like
      // listTemplates() that pass `/templates` end up at
      // <host>/api/daemon/templates → proxied to <daemon>/api/v1/templates.
      return `http://${host}/api/daemon`;
    }
  } catch {
    /* outside request context — fall through to env/default */
  }

  // Fallbacks for non-request server-side contexts. CHORUS_DAEMON_URL
  // is set by `chorus start` when spawning the cockpit child; if that
  // env propagated, use it. Otherwise the v0.7-era default.
  if (process.env.CHORUS_DAEMON_URL) return process.env.CHORUS_DAEMON_URL;
  return "http://127.0.0.1:7707";
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
