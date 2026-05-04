/**
 * System-level routes: blocked-chats list, CLI health snapshot, onboarding
 * helpers (CLI detection + manual path validation), orchestrator wiring
 * for the editors that drive chorus (Claude Code / Cursor / Codex / etc).
 *
 * Decoupled from the runner singleton; only the orchestrator-connect
 * endpoint needs the chorus binary path so the editor's MCP config can
 * point at the right entry script.
 */
import type { FastifyInstance } from 'fastify';
import { chats } from '../../lib/db/index.js';
import {
  successResponse,
  errorResponse,
  type ApiResponse,
} from '../api-response.js';

export interface SystemRouteDeps {
  /** Absolute path to bin/chorus.mjs — used by /orchestrators/:name/connect. */
  chorusBinPath: string;
}

export function registerSystemRoutes(
  fastify: FastifyInstance,
  deps: SystemRouteDeps,
): void {
  // List blocked chats — used by the cockpit's /blocked page.
  fastify.get<{ Reply: ApiResponse<object[]> }>('/blocked', async () => {
    try {
      return successResponse(await chats.list({ status: 'blocked' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── CLI health snapshot ──────────────────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object[]> }>('/cli/health', async () => {
    try {
      const { getAllHealth } = await import('../../lib/cli-health.js');
      return successResponse(await getAllHealth());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── Onboarding: detect installed CLIs + validate manual paths ────────
  fastify.get<{ Reply: ApiResponse<object[]> }>(
    '/onboard/detect-clis',
    async () => {
      try {
        const { detectAllClis } = await import('../../lib/cli-detect.js');
        return successResponse(detectAllClis());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.post<{
    Body: { id: string; path: string };
    Reply: ApiResponse<object>;
  }>('/onboard/validate-cli-path', async (req) => {
    try {
      const { id, path: customPath } = req.body || {};
      if (!id || typeof customPath !== 'string') {
        return errorResponse('bad_request', 'id and path are required');
      }
      const { validateCliPath } = await import('../../lib/cli-detect.js');
      return successResponse(validateCliPath(id as never, customPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── Orchestrators (editors that call chorus via MCP) ────────────────
  fastify.get<{ Reply: ApiResponse<object[]> }>('/orchestrators', async () => {
    try {
      const { listOrchestrators } = await import('../orchestrators/index.js');
      return successResponse(listOrchestrators());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.post<{
    Params: { name: string };
    Reply: ApiResponse<object>;
  }>('/orchestrators/:name/connect', async (request) => {
    try {
      const { connectByName, listOrchestrators } = await import(
        '../orchestrators/index.js'
      );
      const result = await connectByName(request.params.name, {
        binPath: deps.chorusBinPath,
      });
      const status = listOrchestrators().find(
        (o) => o.name === request.params.name,
      );
      return successResponse({ ...result, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── OpenCode model discovery ────────────────────────────────────────
  // Lists models the local `opencode` CLI knows about, grouped by gateway
  // prefix (`opencode/`, `opencode-go/`, `opencode-zen/`). Used by the
  // onboarding flow so users can pick which subscription models they want
  // chorus to expose as voices.
  fastify.get<{
    Reply: ApiResponse<{
      gateways: Record<string, string[]>;
      flat: string[];
      defaultPicks: string[];
    }>;
  }>('/orchestrators/opencode/models', async () => {
    try {
      // Resolve the actual installed path rather than spawning bare
      // 'opencode' — when the daemon's $PATH doesn't include the
      // installer's bin dir (common: opencode lives at
      // ~/.opencode/bin, not in /usr/local/bin), bare lookup ENOENTs
      // even when detection found the binary fine.
      const { detectAllClis } = await import('../../lib/cli-detect.js');
      const opencode = detectAllClis().find((c) => c.id === 'opencode-cli');
      if (!opencode?.found || !opencode.path) {
        return errorResponse(
          'cli_failed',
          'opencode CLI not found on this host. Install from https://opencode.ai or set its path manually in onboarding.',
        );
      }
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run(opencode.path, ['models'], { timeout: 10_000 });
      const flat = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const gateways: Record<string, string[]> = {};
      for (const m of flat) {
        const slash = m.indexOf('/');
        const gw = slash > 0 ? m.slice(0, slash) : 'other';
        if (!gateways[gw]) gateways[gw] = [];
        gateways[gw].push(m);
      }
      // Fleet defaults — kimi + deepseek via Go subscription. Only suggest
      // those that actually appear in the user's `opencode models` output.
      const FLEET = ['opencode-go/kimi-k2.6', 'opencode-go/deepseek-v4-pro'];
      const defaultPicks = FLEET.filter((m) => flat.includes(m));
      return successResponse({ gateways, flat, defaultPicks });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('cli_failed', message);
    }
  });
}
