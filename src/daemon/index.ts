import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { chats, phaseEvents, templates, settings, secrets } from '../lib/db';
import { initTmuxReaper, stopTmuxReaper, createSession, killSession, runPhaseStub } from './tmux';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const PORT = parseInt(process.env.CHORUS_DAEMON_PORT || '7707', 10);
const HOST = '127.0.0.1';
const VERSION = '0.5.0-dev.0';
const startTime = Date.now();

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
    origin: ['http://127.0.0.1:3011'],
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

      // Create tmux session
      createSession(chat.id);

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
      killSession(request.params.id);

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
    try {
      const chat = chats.getById(request.params.id);

      if (!chat) {
        reply.code(404);
        return { error: 'not found' };
      }

      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');

      // Send initial state
      reply.send(`data: ${JSON.stringify({ type: 'init', chat })}\n\n`);

      // Simulate phase progression
      const phaseSequence: Array<{ kind: string; role: string }> = [
        { kind: 'plan', role: 'doer' },
        { kind: 'spec', role: 'doer' },
        { kind: 'tests', role: 'doer' },
        { kind: 'implement', role: 'doer' },
        { kind: 'review', role: 'reviewer' },
      ];

      for (let i = 0; i < phaseSequence.length; i++) {
        const phase = phaseSequence[i];

        // Simulate phase start
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const output = await runPhaseStub(chat.id, phase.kind);

        // Update phase event
        const events = phaseEvents.list(chat.id);
        const eventForPhase = events.find((e) => e.phase_kind === phase.kind);

        if (eventForPhase) {
          phaseEvents.update(eventForPhase.id, {
            state: 'submitted',
            output,
            finished_at: Date.now(),
          });
        }

        reply.send(
          `data: ${JSON.stringify({ type: 'phase_update', phase: phase.kind, state: 'submitted', output })}\n\n`
        );

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Mark as finished
      chats.update(chat.id, { status: 'approved', finished_at: Date.now() });
      reply.send(`data: ${JSON.stringify({ type: 'finished', status: 'approved' })}\n\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error(error);
      reply.send(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
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

  // Seed built-in templates on startup
  seedBuiltinTemplates();

  // Initialize tmux reaper
  initTmuxReaper();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    stopTmuxReaper();
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
