import { NextRequest, NextResponse } from "next/server";

/**
 * Generic proxy: /api/daemon/<path> → http://127.0.0.1:7707/<path>
 *
 * Why: the browser cannot reach the daemon directly (127.0.0.1 in the user's
 * browser is the user's machine, not the server hosting the Next app).
 * Server-side fetches still hit the daemon URL directly via lib/api/client.ts.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DAEMON_URL =
  process.env.CHORUS_DAEMON_URL || "http://127.0.0.1:7707";

interface ProxyContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(req: NextRequest, ctx: ProxyContext): Promise<Response> {
  const { path } = await ctx.params;
  const segments = path.join("/");
  const search = req.nextUrl.search;
  const target = `${DAEMON_URL}/${segments}${search}`;

  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const init: RequestInit = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
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
