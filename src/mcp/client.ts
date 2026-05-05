/**
 * Fetch wrapper around the daemon REST API on http://127.0.0.1:7707.
 * Handles connection errors with user-friendly guidance.
 */

import { z } from "zod";

const DAEMON_BASE = "http://127.0.0.1:7707";
const API_PREFIX = "/api/v1";

/**
 * Prepend /api/v1 to a daemon path unless the caller already supplied
 * it. Exact-segment match required — a naive startsWith would treat
 * `/api/v10/...` or `/api/v1foo/...` as already-prefixed and skip
 * prepending.
 */
function v1(path: string): string {
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return path;
  return `${API_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}

const ApiResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Fetch JSON from daemon, parse response, handle errors.
 * Throws an error if daemon is unreachable or response is invalid.
 */
export async function daemonFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${DAEMON_BASE}${v1(path)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (error: unknown) {
    // Connection refused or network error
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      throw new Error(
        "Chorus daemon not running. Run 'chorus start' first."
      );
    }
    throw error;
  }

  // Parse the JSON envelope FIRST, regardless of HTTP status. The
  // daemon now returns 4xx for client errors (validation/not_found/
  // conflict) per the v0.7 shape-freeze; without this, MCP consumers
  // would see ugly raw-text errors like `Daemon returned 400: {...}`
  // instead of the nice `error.message` they get on 200+ok:false.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(
      `Daemon returned ${response.status} ${response.statusText} with non-JSON body`,
    );
  }

  const parsed = ApiResponseSchema.parse(json);

  if (!parsed.ok) {
    throw new Error(
      parsed.error?.message || "Daemon returned an error with no message"
    );
  }

  return parsed.data as T;
}

/**
 * Consume SSE stream and emit progress events.
 * Yields one item per event until the stream closes or timeout expires.
 */
export async function* streamChat(
  chatId: string,
  timeoutSec: number = 600
): AsyncGenerator<Record<string, unknown>> {
  const url = `${DAEMON_BASE}${v1(`/chats/${chatId}/stream`)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Stream returned ${response.status}: ${response.statusText}`
      );
    }

    if (!response.body) {
      throw new Error("Stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data) {
            try {
              yield JSON.parse(data);
            } catch {
              // Ignore malformed lines
            }
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer) {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6);
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // Ignore malformed lines
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
