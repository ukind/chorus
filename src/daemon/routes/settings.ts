/**
 * Settings + secrets routes.
 *
 * Covers four sub-namespaces: base settings (key/value), permissions
 * (sandbox profile + per-tool auto-approve), transport (headless vs tmux),
 * and billing mode (subscription vs API). All decoupled from the runner.
 */
import type { FastifyInstance } from 'fastify';
import { settings, secrets } from '../../lib/db/index.js';
import {
  successResponse,
  errorResponse,
  type ApiResponse,
} from '../api-response.js';

export function registerSettingsRoutes(fastify: FastifyInstance): void {
  // ─── Base settings (key/value bag) ───────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>('/settings', async () => {
    try {
      const allSettings = await settings.getAll();
      return successResponse(allSettings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.put<{
    Body: Record<string, unknown>;
    Reply: ApiResponse<object>;
  }>('/settings', async (request) => {
    try {
      const updates = request.body;
      for (const [key, value] of Object.entries(updates)) {
        await settings.set(key, value);
      }
      return successResponse(await settings.getAll());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── Permissions (sandbox + auto-approve + network) ──────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/permissions',
    async () => {
      try {
        const { getPermissions, PROFILE_DESCRIPTIONS } = await import(
          '../../lib/settings/permissions.js'
        );
        return successResponse({
          ...(await getPermissions()),
          profileDescriptions: PROFILE_DESCRIPTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: {
      sandboxProfile?: string;
      autoApprovePrompts?: boolean;
      networkAccess?: boolean;
    };
    Reply: ApiResponse<object>;
  }>('/settings/permissions', async (request) => {
    try {
      const { setPermissions } = await import('../../lib/settings/permissions.js');
      const body = request.body ?? {};
      const next = await setPermissions({
        ...(body.sandboxProfile !== undefined && {
          sandboxProfile: body.sandboxProfile as 'strict' | 'workspace' | 'full',
        }),
        ...(body.autoApprovePrompts !== undefined && {
          autoApprovePrompts: body.autoApprovePrompts,
        }),
        ...(body.networkAccess !== undefined && {
          networkAccess: body.networkAccess,
        }),
      });
      return successResponse(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Transport (headless vs tmux) ────────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/transport',
    async () => {
      try {
        const { getTransport, TRANSPORT_DESCRIPTIONS } = await import(
          '../../lib/settings/transport.js'
        );
        return successResponse({
          transport: await getTransport(),
          descriptions: TRANSPORT_DESCRIPTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: { transport: 'headless' | 'tmux' };
    Reply: ApiResponse<object>;
  }>('/settings/transport', async (request) => {
    try {
      const { setTransport } = await import('../../lib/settings/transport.js');
      const body = request.body ?? ({} as { transport: 'headless' | 'tmux' });
      if (body.transport !== 'headless' && body.transport !== 'tmux') {
        return errorResponse('validation', 'transport must be "headless" or "tmux"');
      }
      return successResponse({ transport: await setTransport(body.transport) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Billing mode (subscription vs API) ──────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>('/settings/billing', async () => {
    try {
      const { getBillingMode, BILLING_MODE_LABELS } = await import(
        '../../lib/settings/billing.js'
      );
      return successResponse({
        mode: await getBillingMode(),
        descriptions: BILLING_MODE_LABELS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.put<{
    Body: { mode: 'api' | 'subscription' | 'mixed' };
    Reply: ApiResponse<object>;
  }>('/settings/billing', async (request) => {
    try {
      const { setBillingMode } = await import('../../lib/settings/billing.js');
      const body =
        request.body ?? ({} as { mode: 'api' | 'subscription' | 'mixed' });
      if (
        body.mode !== 'api' &&
        body.mode !== 'subscription' &&
        body.mode !== 'mixed'
      ) {
        return errorResponse(
          'validation',
          'mode must be "api" | "subscription" | "mixed"',
        );
      }
      return successResponse({ mode: await setBillingMode(body.mode) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });
}

export function registerSecretRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Reply: ApiResponse<object[]> }>('/secrets', async () => {
    try {
      return successResponse(await secrets.list());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.put<{
    Params: { provider: string };
    Body: { value: string; kind: string; meta?: Record<string, unknown> };
    Reply: ApiResponse<object>;
  }>('/secrets/:provider', async (request) => {
    try {
      const { provider } = request.params;
      const { value, kind, meta } = request.body;
      if (!value || !kind) {
        return errorResponse('validation', 'value and kind are required');
      }
      await secrets.set(provider, kind as 'api_key' | 'cli_subscription', value, meta);
      return successResponse({ provider, kind, updated_at: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });
}
