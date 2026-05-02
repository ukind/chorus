// Fetch wrapper with error handling and base URL management
import { ApiResponse } from "@/lib/types";

// Server-side: hit the daemon directly on this host.
// Browser-side: go through the Next.js proxy at /api/daemon (the browser
// cannot reach 127.0.0.1 on the server).
const SERVER_BASE =
  process.env.CHORUS_DAEMON_URL || "http://127.0.0.1:7707";
const CLIENT_BASE = "/api/daemon";

function getBaseUrl(): string {
  if (typeof window === "undefined") return SERVER_BASE;
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
  const base = getBaseUrl();
  const url = base.endsWith("/") || path.startsWith("/")
    ? `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
    : `${base}/${path}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const data: ApiResponse<T> = await response.json().catch(() => ({
      ok: false,
      error: {
        code: "parse_error",
        message: "Failed to parse response",
      },
    }));

    if (!data.ok) {
      throw new DaemonError(
        data.error?.code || "unknown",
        response.status,
        data.error?.message || "Unknown error",
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
