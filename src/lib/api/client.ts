// Fetch wrapper with error handling and base URL management
import { ApiResponse } from "@/lib/types";

const BASE_URL =
  process.env.NEXT_PUBLIC_CHORUS_DAEMON_URL || "http://127.0.0.1:7707";

export class DaemonError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export async function fetchFromDaemon<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(path, BASE_URL).toString();

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
