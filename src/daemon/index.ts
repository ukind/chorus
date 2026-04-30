import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { chats, phaseEvents, templates, settings, secrets } from '../lib/db';
import { TmuxManagerImpl } from './tmux.js';
import { startReaper } from './reaper.js';
import { runChat } from './runner.js';
import { ErrorDetector } from './error-detector.js';
import { TemplateSchema } from '../lib/template-schema.js';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const PORT = parseInt(process.env.CHORUS_DAEMON_PORT || '7707', 10);
const HOST = '127.0.0.1';
const VERSION = '0.5.0-dev.0';
const startTime = Date.now();

// Absolute path to bin/chorus.mjs — used by /orchestrators/:name/connect when
// the cockpit triggers a one-click wire-up. Both src/daemon/index.ts (tsx)
// and dist/daemon/index.js (PM2/built) resolve to <pkg-root>/bin/chorus.mjs.
const CHORUS_BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'chorus.mjs');

// Singletons shared across the daemon lifetime.
let tmuxMgr: TmuxManagerImpl;
let stopReaper: (() => void) | null = null;
const errorDetector = new ErrorDetector();

// Error response type
interface ErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

interface SuccessResponse<T> {
  ok: true;
  data: T;
}

type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

function errorResponse(code: string, message: string): ErrorResponse {
  return {
    ok: false,
    error: { code, message },
  };
}

function successResponse<T>(data: T): SuccessResponse<T> {
  return {
    ok: true,
    data,
  };
}

async function main() {
  const fastify = Fastify({ logger: false });

  // CORS
  await fastify.register(fastifyCors, {
    origin: ['http://127.0.0.1:5050'],
    credentials: true,
  });

  // Health check
  fastify.get<{ Reply: ApiResponse<{ ok: boolean; version: string; uptime: number }> }>(
    '/health',
    async () => {
      return successResponse({
        ok: true,
        version: VERSION,
        uptime: Date.now() - startTime,
      });
    }
  );

  // List chats
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
    Reply: ApiResponse<object[]>;
  }>('/chats', async (request) => {
    try {
      const { status, limit, offset } = request.query;

      const list = chats.list({
        status: status || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });

      return successResponse(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Get one chat with phase events
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id', async (request) => {
    try {
      const chat = chats.getById(request.params.id);

      if (!chat) {
        return errorResponse('not_found', `Chat ${request.params.id} not found`);
      }

      const events = phaseEvents.list(request.params.id);

      return successResponse({ ...chat, events });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Create chat
  fastify.post<{
    Body: { work: string; templateId: string; files?: string[] };
    Reply: ApiResponse<object>;
  }>('/chats', async (request) => {
    try {
      const { work, templateId, files } = request.body;

      if (!work || !templateId) {
        return errorResponse('validation', 'work and templateId are required');
      }

      const chat = chats.create({
        work,
        template_id: templateId,
        attached_files: files ? JSON.stringify(files) : undefined,
      });

      // Note: tmux sessions are created on-demand via tmuxMgr.acquire() when phases run.
      // This endpoint is for chat creation only.

      // Create initial phase event
      phaseEvents.create({
        chat_id: chat.id,
        phase_idx: 0,
        phase_kind: 'plan',
        role: 'doer',
        agent_id: null,
        state: 'drafting',
        output: null,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        started_at: Date.now(),
        finished_at: null,
      });

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Cancel chat
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/cancel', async (request) => {
    try {
      const chat = chats.cancel(request.params.id);

      // Kill any tmux sessions associated with this chat
      const allSessions = tmuxMgr.list();
      for (const session of allSessions) {
        if (session.chatId === request.params.id) {
          tmuxMgr.kill(session.name);
        }
      }

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Resume (answer blocking question)
  fastify.post<{
    Params: { id: string };
    Body: { answer: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/resume', async (request) => {
    try {
      const { answer } = request.body;

      if (!answer) {
        return errorResponse('validation', 'answer is required');
      }

      const chat = chats.update(request.params.id, { status: 'reviewing' });

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // SSE stream: phase events
  fastify.get<{
    Params: { id: string };
  }>('/chats/:id/stream', async (request, reply) => {
    const chatId = request.params.id;

    try {
      const chat = chats.getById(chatId);

      if (!chat) {
        reply.code(404);
        return { error: 'not found' };
      }

      const tmplRow = templates.getById(chat.template_id);
      if (!tmplRow) {
        reply.code(404);
        return { error: 'template not found' };
      }

      // Parse template YAML
      let template;
      try {
        const parsed = yaml.parse(tmplRow.yaml);
        template = TemplateSchema.parse(parsed);
      } catch (parseError) {
        reply.code(400);
        return {
          error: `Invalid template: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Abort controller for early termination
      const ac = new AbortController();
      request.raw.on('close', () => {
        ac.abort();
      });

      // Run the chat
      await runChat({
        chatId,
        template,
        work: chat.work,
        abortSignal: ac.signal,
        tmuxMgr,
        errorDetector,
        onEvent: (event) => {
          // Write SSE event
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

          // Persist certain events to DB
          if (
            event.type === 'phase_start' ||
            event.type === 'phase_done' ||
            event.type === 'phase_failed'
          ) {
            const payload = event.payload as Record<string, unknown>;
            const kind = payload.kind as string;
            const validKinds = ['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence'];
            const phaseKind = validKinds.includes(kind)
              ? (kind as 'plan' | 'spec' | 'tests' | 'implement' | 'review' | 'verify' | 'divergence')
              : 'plan';
            phaseEvents.create({
              chat_id: chatId,
              phase_idx: (payload.phaseIdx as number) ?? 0,
              phase_kind: phaseKind,
              role: (payload.role as 'doer' | 'reviewer') ?? 'doer',
              agent_id: (payload.agent as string) ?? null,
              state:
                event.type === 'phase_start'
                  ? 'drafting'
                  : event.type === 'phase_done'
                    ? 'submitted'
                    : 'blocked',
              output: (payload.output as string) ?? null,
              cost_usd: 0,
              tokens_in: 0,
              tokens_out: 0,
              started_at: event.ts,
              finished_at:
                event.type === 'phase_done' || event.type === 'phase_failed'
                  ? Date.now()
                  : null,
            });
          }

          // Update chat status on completion
          if (event.type === 'chat_done') {
            const payload = event.payload as Record<string, unknown>;
            const status = (payload.status as string) ?? 'completed';
            chats.update(chatId, {
              status: (status === 'completed' ? 'approved' : status) as
                | 'drafting'
                | 'reviewing'
                | 'approved'
                | 'merged'
                | 'blocked'
                | 'cancelled'
                | 'failed'
                | 'no_review',
              finished_at: Date.now(),
            });
          }
        },
      });

      reply.raw.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error(error);
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
      reply.raw.end();
    }
  });

  // List templates
  fastify.get<{
    Reply: ApiResponse<object[]>;
  }>('/templates', async () => {
    try {
      const list = templates.list();

      return successResponse(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Get one template
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/templates/:id', async (request) => {
    try {
      const template = templates.getById(request.params.id);

      if (!template) {
        return errorResponse('not_found', `Template ${request.params.id} not found`);
      }

      // Parse YAML to JSON
      const parsed = yaml.parse(template.yaml);

      return successResponse({ ...template, parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Save user template
  fastify.post<{
    Body: { id: string; yaml: string };
    Reply: ApiResponse<object>;
  }>('/templates', async (request) => {
    try {
      const { id, yaml: yamlContent } = request.body;

      if (!id || !yamlContent) {
        return errorResponse('validation', 'id and yaml are required');
      }

      // Validate YAML
      try {
        yaml.parse(yamlContent);
      } catch (parseError) {
        return errorResponse('validation', `Invalid YAML: ${parseError}`);
      }

      const template = templates.create(id, yamlContent, 'user');

      return successResponse(template);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // List blocked chats
  fastify.get<{
    Reply: ApiResponse<object[]>;
  }>('/blocked', async () => {
    try {
      const list = chats.list({ status: 'blocked' });

      return successResponse(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Get settings
  fastify.get<{
    Reply: ApiResponse<object>;
  }>('/settings', async () => {
    try {
      const allSettings = settings.getAll();

      return successResponse(allSettings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Update settings
  fastify.put<{
    Body: Record<string, unknown>;
    Reply: ApiResponse<object>;
  }>('/settings', async (request) => {
    try {
      const { ...updates } = request.body;

      for (const [key, value] of Object.entries(updates)) {
        settings.set(key, value);
      }

      const allSettings = settings.getAll();

      return successResponse(allSettings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // List secrets (no values)
  fastify.get<{
    Reply: ApiResponse<object[]>;
  }>('/secrets', async () => {
    try {
      const list = secrets.list();

      return successResponse(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Set secret
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

      secrets.set(provider, kind as 'api_key' | 'cli_subscription', value, meta);

      return successResponse({ provider, kind, updated_at: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── CLI health ─────────────────────────────────────────────────────────

  fastify.get<{ Reply: ApiResponse<object[]> }>('/cli/health', async () => {
    try {
      const { getAllHealth } = await import('../lib/cli-health.js');
      return successResponse(getAllHealth());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── Permission settings ────────────────────────────────────────────────

  fastify.get<{ Reply: ApiResponse<object> }>('/settings/permissions', async () => {
    try {
      const { getPermissions, PROFILE_DESCRIPTIONS } = await import('../lib/settings/permissions.js');
      return successResponse({
        ...getPermissions(),
        profileDescriptions: PROFILE_DESCRIPTIONS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.put<{
    Body: { sandboxProfile?: string; autoApprovePrompts?: boolean; networkAccess?: boolean };
    Reply: ApiResponse<object>;
  }>('/settings/permissions', async (request) => {
    try {
      const { setPermissions } = await import('../lib/settings/permissions.js');
      const body = request.body ?? {};
      const next = setPermissions({
        ...(body.sandboxProfile !== undefined && {
          sandboxProfile: body.sandboxProfile as 'strict' | 'workspace' | 'full',
        }),
        ...(body.autoApprovePrompts !== undefined && { autoApprovePrompts: body.autoApprovePrompts }),
        ...(body.networkAccess !== undefined && { networkAccess: body.networkAccess }),
      });
      return successResponse(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Transport setting (headless vs tmux) ───────────────────────────────

  fastify.get<{ Reply: ApiResponse<object> }>('/settings/transport', async () => {
    try {
      const { getTransport, TRANSPORT_DESCRIPTIONS } = await import('../lib/settings/transport.js');
      return successResponse({
        transport: getTransport(),
        descriptions: TRANSPORT_DESCRIPTIONS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.put<{
    Body: { transport: 'headless' | 'tmux' };
    Reply: ApiResponse<object>;
  }>('/settings/transport', async (request) => {
    try {
      const { setTransport } = await import('../lib/settings/transport.js');
      const body = request.body ?? ({} as { transport: 'headless' | 'tmux' });
      if (body.transport !== 'headless' && body.transport !== 'tmux') {
        return errorResponse('validation', 'transport must be "headless" or "tmux"');
      }
      const next = setTransport(body.transport);
      return successResponse({ transport: next });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // List orchestrators with their connection status
  fastify.get<{
    Reply: ApiResponse<object[]>;
  }>('/orchestrators', async () => {
    try {
      const { listOrchestrators } = await import('./orchestrators.js');
      return successResponse(listOrchestrators());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // Pre-approve all Chorus MCP tools in the named orchestrator
  fastify.post<{
    Params: { name: string };
    Reply: ApiResponse<object>;
  }>('/orchestrators/:name/connect', async (request) => {
    try {
      const { connectByName, listOrchestrators } = await import('./orchestrators.js');
      const result = connectByName(request.params.name, { binPath: CHORUS_BIN_PATH });
      const status = listOrchestrators().find((o) => o.name === request.params.name);
      return successResponse({ ...result, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // Seed built-in templates on startup
  seedBuiltinTemplates();

  // Reap orphan headless subprocesses from any prior daemon crash. Without
  // this, a hung CLI from a previous run keeps burning subscription quota
  // until manually killed. Safe to call on every startup.
  try {
    const { reapOrphanProcesses } = await import('./headless.js');
    const result = reapOrphanProcesses();
    if (result.reaped > 0 || result.cleared > 0) {
      console.log(
        `[chorus] reaper: killed ${result.reaped} orphan headless processes, cleared ${result.cleared} stale records`,
      );
    }
  } catch (err) {
    // Non-fatal — orphan cleanup is best-effort.
    console.warn('[chorus] reaper: failed to scan PID dir', err);
  }

  // Initialize tmux manager and reaper
  tmuxMgr = new TmuxManagerImpl();
  stopReaper = startReaper(tmuxMgr, () => {
    // getActiveChats: return a map of chatId → status
    const allChats = chats.list({ status: undefined, limit: 1000, offset: 0 });
    const activeMap = new Map<string, string>();
    for (const chat of allChats) {
      activeMap.set(chat.id, chat.status);
    }
    return activeMap;
  }, {
    intervalMs: 5 * 60 * 1000, // 5 min
    idleDestroyMinutes: 30,
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    if (stopReaper) {
      stopReaper();
    }
    await fastify.close();
    process.exit(0);
  });

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`Chorus daemon listening on http://${HOST}:${PORT}`);
}

function seedBuiltinTemplates(): void {
  const templatesDir = path.join(__dirname, '..', '..', 'templates');

  if (!fs.existsSync(templatesDir)) {
    console.log('No templates directory found, skipping seed');
    return;
  }

  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));

  for (const file of files) {
    const id = file.replace('.yaml', '');
    const yamlPath = path.join(templatesDir, file);
    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

    const existing = templates.getById(id);

    if (!existing) {
      templates.create(id, yamlContent, 'builtin');
      console.log(`Seeded template: ${id}`);
    }
  }
}

main().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});

/**
 * Export the tmux manager for use by other daemon modules (runner, agents, etc.)
 */
export function getTmuxManager(): TmuxManagerImpl {
  if (!tmuxMgr) {
    throw new Error('TmuxManager not initialized. Daemon may not have started yet.');
  }
  return tmuxMgr;
}
