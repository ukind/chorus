import { NextRequest, NextResponse } from "next/server";

/**
 * Generic proxy: /api/daemon/<path> → http://127.0.0.1:7707/api/v1/<path>
 *
 * Why: the browser cannot reach the daemon directly (127.0.0.1 in the user's
 * browser is the user's machine, not the server hosting the Next app).
 * Server-side fetches still hit the daemon URL directly via lib/api/client.ts.
 *
 * The proxy auto-prepends `/api/v1` when the caller didn't already
 * include it, so cockpit code can keep saying `/api/daemon/chats/...`
 * during the v0.7 → v1 migration. Callers that explicitly want a
 * different version can pass `/api/daemon/api/v1/...` and the prefix is
 * left alone.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAEMON_URL =
  process.env.CHORUS_DAEMON_URL || "http://127.0.0.1:7707";
const API_PREFIX = "api/v1";

interface ProxyContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(req: NextRequest, ctx: ProxyContext): Promise<Response> {
  const { path } = await ctx.params;
  const segments = path.join("/");
  // Auto-prepend /api/v1 so cockpit code can call /api/daemon/<route>
  // while the daemon itself only exposes the versioned shape. Exact
  // segment check — `startsWith("api/v1")` would naively match
  // `api/v10/...` or `api/v1foo/...` and skip prepending.
  const isPrefixed = segments === API_PREFIX || segments.startsWith(`${API_PREFIX}/`);
  const versionedSegments = isPrefixed
    ? segments
    : `${API_PREFIX}/${segments}`;
  const search = req.nextUrl.search;
  const target = `${DAEMON_URL}/${versionedSegments}${search}`;

  const headers = new Headers();
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init: RequestInit = {
    method: req.method,
    headers,
  };

  // Body forwarding rule: read the request body when content-length says
  // one is present OR the request is using chunked transfer-encoding
  // (which sends no content-length). Without the chunked check, large
  // uploads sent via Transfer-Encoding: chunked would silently drop their
  // body. The Content-Length-only path is the common one — fetchFromDaemon
  // never streams. The whole guard exists because Next 16's body iterator
  // hangs (UND_ERR_BODY_TIMEOUT) when Content-Type is set with no body —
  // see DELETE through fetchFromDaemon. We also drop the upstream
  // Content-Type for empty requests because Fastify rejects
  // application/json + empty body with FST_ERR_CTP_EMPTY_JSON_BODY.
  const hasContentLength =
    Number(req.headers.get("content-length") ?? "0") > 0;
  const isChunked = (req.headers.get("transfer-encoding") ?? "")
    .toLowerCase()
    .includes("chunked");
  const hasBody =
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    (hasContentLength || isChunked);
  if (hasBody) {
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    // arrayBuffer over text() — text() decodes the body as UTF-8 and
    // replaces invalid bytes with U+FFFD, which would silently corrupt
    // any future binary upload (file import, screenshot, etc.). All
    // current callers send JSON, so the practical impact today is nil,
    // but the proxy is a generic forward and shouldn't impose an
    // encoding on bytes it's just relaying.
    init.body = await req.arrayBuffer();
  }

  try {
    const upstream = await fetch(target, init);

    // Pass-through stream for SSE
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "daemon_unreachable",
          message:
            "Chorus daemon is not running on this host. Start it with `chorus start`.",
        },
      },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
