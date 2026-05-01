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
      return successResponse(chats.list({ status: 'blocked' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── CLI health snapshot ──────────────────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object[]> }>('/cli/health', async () => {
    try {
      const { getAllHealth } = await import('../../lib/cli-health.js');
      return successResponse(getAllHealth());
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
      const { listOrchestrators } = await import('../orchestrators.js');
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
        '../orchestrators.js'
      );
      const result = connectByName(request.params.name, {
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
}
