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
const VERSION = '0.7.0-dev.0';
const startTime = Date.now();

// Absolute path to bin/chorus.mjs — used by /orchestrators/:name/connect when
// the cockpit triggers a one-click wire-up. Both src/daemon/index.ts (tsx)
// and dist/daemon/index.js (PM2/built) resolve to <pkg-root>/bin/chorus.mjs.
const CHORUS_BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'chorus.mjs');

// Singletons shared across the daemon lifetime.
let tmuxMgr: TmuxManagerImpl;
let stopReaper: (() => void) | null = null;
const errorDetector = new ErrorDetector();

// chat.attached_files is stored as a JSON-encoded string[]. Parse defensively
// — bad JSON or non-array shape returns an empty list rather than crashing
// the runner.
function parseAttachedFiles(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// Type imported for ActiveRun event signature. Matches runner.ts RunnerEvent.
type SubscriberFn = (eventJson: string) => void;

interface ActiveRun {
  promise: Promise<void>;
  subscribers: Set<SubscriberFn>;
  abortController: AbortController;
}

// Singleton runner registry — one runChat per chatId, ever. SSE re-attachers
// (browser refresh, tab open, polling, MCP wait_for_chat) all subscribe to
// the same in-memory event bus instead of re-firing the runner. Without this,
// every refresh of the run page used to spawn a fresh doer + 2 reviewers,
// hammering the LLM CLIs and thrashing system memory. See ROADMAP #17.
const activeRuns = new Map<string, ActiveRun>();

// Reconstruct a RunnerEvent from a persisted phase_events row. Used to
// replay past events to a freshly-attached SSE so the run page renders
// the history without waiting for the next live event. Returns null for
// rows we can't faithfully reconstruct.
function phaseEventToRunnerEvent(
  chatId: string,
  ev: ReturnType<typeof phaseEvents.list>[number],
): Record<string, unknown> | null {
  const baseType =
    ev.state === 'drafting'
      ? 'phase_start'
      : ev.state === 'submitted'
        ? 'phase_done'
        : ev.state === 'blocked'
          ? 'phase_failed'
          : null;
  if (!baseType) return null;
  return {
    chatId,
    type: baseType,
    payload: {
      phaseIdx: ev.phase_idx,
      kind: ev.phase_kind,
      role: ev.role,
      agent: ev.agent_id ?? undefined,
      output: ev.output ?? undefined,
      replay: true,
    },
    ts: ev.started_at,
  };
}

interface RunWithMultiplexArgs {
  chatId: string;
  template: ReturnType<typeof TemplateSchema.parse>;
  chat: NonNullable<ReturnType<typeof chats.getById>>;
}

function runWithMultiplex(args: RunWithMultiplexArgs): ActiveRun {
  const { chatId, template, chat } = args;

  // Explicit cancellation goes through POST /chats/:id/cancel which calls
  // entry.abortController.abort(). Closing an SSE does NOT abort.
  const abortController = new AbortController();
  const subscribers = new Set<SubscriberFn>();

  // Single onEvent for the runChat. Persists side effects exactly once and
  // fans out to every subscribed SSE. Any subscriber whose write throws is
  // silently dropped — we never block the runner on a dead client.
  const onEvent: Parameters<typeof runChat>[0]['onEvent'] = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of subscribers) {
      try {
        sub(line);
      } catch {
        /* dead subscriber — leave; the SSE close handler will unsubscribe */
      }
    }

    // Persist phase events. Same logic as before, lifted from the inline SSE
    // handler so it runs once regardless of subscriber count.
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

    // Update chats.status on terminal event. Same translation as before:
    // runner emits status='completed' for the happy path; we map to
    // 'approved' to fit the chats.status enum.
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
        ...(typeof payload.prUrl === 'string' && payload.prUrl.length > 0
          ? { pr_url: payload.prUrl }
          : {}),
        ...(typeof payload.shipError === 'string' && payload.shipError.length > 0
          ? { ship_error: payload.shipError }
          : {}),
        finished_at: Date.now(),
      });
    }
  };

  const promise = runChat({
    chatId,
    template,
    work: chat.work,
    repoPath: chat.repo_path ?? undefined,
    attachedFiles: parseAttachedFiles(chat.attached_files),
    abortSignal: abortController.signal,
    tmuxMgr,
    errorDetector,
    onEvent,
  }).finally(() => {
    // Always release the registry slot when the runner exits. Subsequent SSE
    // attachers fall through to the terminal-state replay branch above.
    activeRuns.delete(chatId);
  });

  const entry: ActiveRun = { promise, subscribers, abortController };
  activeRuns.set(chatId, entry);
  return entry;
}

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

  // Seed built-in personas from prompts/personas/*.md.
  // Idempotent: built-in rows refresh from the file source of truth on every
  // startup; user-created rows (builtin=0) are not touched.
  try {
    const { seedBuiltinPersonas } = await import('../lib/personas.js');
    const count = seedBuiltinPersonas();
    // eslint-disable-next-line no-console
    console.log(`[daemon] seeded ${count} built-in personas`);
  } catch (err) {
    // Non-fatal: daemon still works without personas. Log for diagnostics.
    // eslint-disable-next-line no-console
    console.warn('[daemon] persona seed failed:', err instanceof Error ? err.message : err);
  }

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
    Body: { work: string; templateId: string; files?: string[]; repoPath?: string };
    Reply: ApiResponse<object>;
  }>('/chats', async (request) => {
    try {
      const { work, templateId, files, repoPath } = request.body;

      if (!work || !templateId) {
        return errorResponse('validation', 'work and templateId are required');
      }

      // Validate repoPath if supplied — must be an absolute path to an
      // existing directory. Stricter checks (is-a-repo, gh-authed) happen
      // when the ship phase runs, not at chat creation time.
      if (repoPath !== undefined) {
        if (typeof repoPath !== 'string' || !repoPath.startsWith('/')) {
          return errorResponse('validation', 'repoPath must be an absolute path');
        }
        const fsModule = await import('fs');
        if (!fsModule.existsSync(repoPath)) {
          return errorResponse('validation', `repoPath does not exist: ${repoPath}`);
        }
      }

      // Read the template's first phase kind so the initial drafting event
      // reflects the actual pipeline (review / plan / spec / etc.) instead
      // of always claiming 'plan'. Falls back to 'plan' on any read/parse
      // error — initial event is informational, not load-bearing for the
      // runner.
      let initialPhaseKind: 'plan' | 'spec' | 'tests' | 'implement' | 'review' | 'verify' | 'divergence' = 'plan';
      try {
        const tmpl = templates.getById(templateId);
        if (tmpl) {
          const parsed = yaml.parse(tmpl.yaml) as { phases?: Array<{ kind?: string }> } | undefined;
          const firstKind = parsed?.phases?.[0]?.kind;
          const validKinds = ['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence'] as const;
          if (typeof firstKind === 'string' && (validKinds as readonly string[]).includes(firstKind)) {
            initialPhaseKind = firstKind as typeof initialPhaseKind;
          }
        }
      } catch {
        /* fall through with 'plan' default */
      }

      const chat = chats.create({
        work,
        template_id: templateId,
        attached_files: files ? JSON.stringify(files) : undefined,
        repo_path: repoPath,
      });

      // Note: tmux sessions are created on-demand via tmuxMgr.acquire() when phases run.
      // This endpoint is for chat creation only.

      // Create initial phase event
      phaseEvents.create({
        chat_id: chat.id,
        phase_idx: 0,
        phase_kind: initialPhaseKind,
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
      const chatId = request.params.id;
      const chat = chats.cancel(chatId);

      // Abort the active runner if there is one. This propagates into the
      // runChat abortListener which fires chat_done(cancelled) once (latched
      // by emitChatDone) — including killing any LLM CLI subprocesses via
      // their AbortSignal. Without this, cancel only flipped the DB row and
      // the runner kept burning tokens until natural termination.
      const active = activeRuns.get(chatId);
      if (active) {
        active.abortController.abort();
      }

      // Kill any tmux sessions associated with this chat (legacy transport).
      const allSessions = tmuxMgr.list();
      for (const session of allSessions) {
        if (session.chatId === chatId) {
          tmuxMgr.kill(session.name);
        }
      }

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Delete chat (hard delete: row + phase_events + filesystem artifacts).
  // Cancels any active session first to avoid orphaned subprocesses writing
  // to the dir we're about to nuke. Idempotent: returns 200 even if the
  // chat is already gone (allows the cockpit to retry without distinguishing
  // races).
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id', async (request) => {
    try {
      const id = request.params.id;
      const existing = chats.getById(id);
      if (!existing) {
        return successResponse({ id, deleted: false, reason: 'not_found' });
      }

      // 1. Cancel first if still active — flips status, signals abort.
      if (
        existing.status === 'drafting' ||
        existing.status === 'reviewing'
      ) {
        try {
          chats.cancel(id);
        } catch {
          /* best-effort */
        }
      }

      // 1b. Abort the in-memory runner if one is active for this chat.
      // Otherwise the runner could keep streaming events and write to a chat
      // dir that we're about to rm -rf, plus it would re-create the row.
      const active = activeRuns.get(id);
      if (active) {
        active.abortController.abort();
      }

      // 2. Kill any tmux sessions tied to this chat.
      try {
        const allSessions = tmuxMgr.list();
        for (const session of allSessions) {
          if (session.chatId === id) tmuxMgr.kill(session.name);
        }
      } catch {
        /* tmuxMgr may not be ready in test paths */
      }

      // 3. Drop DB row + phase events.
      chats.delete(id);

      // 4. Nuke chat artifacts directory.
      const fsModule = await import('fs');
      const pathModule = await import('path');
      const osModule = await import('os');
      const chatDir = pathModule.join(osModule.homedir(), '.chorus', 'chats', id);
      if (fsModule.existsSync(chatDir)) {
        try {
          fsModule.rmSync(chatDir, { recursive: true, force: true });
        } catch (err) {
          // Don't fail the request — DB row is already gone, dir is just
          // disk-space cleanup.
          console.warn(`[chorus] failed to remove ${chatDir}:`, err);
        }
      }

      return successResponse({ id, deleted: true });
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

      // Subscriber for THIS SSE connection. Pushes a pre-serialised JSON
      // string to the wire; the persistence + status-update side effects
      // live in the runner-side onEvent (see runWithMultiplex below) and
      // happen exactly once per event regardless of how many SSEs subscribe.
      const subscriber: SubscriberFn = (line) => {
        try {
          reply.raw.write(line);
        } catch {
          /* connection closed mid-write — unsubscribe handles cleanup */
        }
      };

      // Replay past phase_events from DB so a late-attach run page sees the
      // history immediately instead of a blank screen. We synthesise the same
      // RunnerEvent shape the live stream uses (phase_start / phase_done /
      // phase_failed). This is best-effort — DB doesn't capture phase_progress
      // or cli_error, so live tail is still richer.
      const pastEvents = phaseEvents.list(chatId);
      for (const ev of pastEvents) {
        const reconstructed = phaseEventToRunnerEvent(chatId, ev);
        if (reconstructed) {
          subscriber(`data: ${JSON.stringify(reconstructed)}\n\n`);
        }
      }

      // If chat is already terminal, replay is enough — close after sending
      // a synthetic chat_done so the client knows it's caught up.
      const TERMINAL: ReadonlyArray<typeof chat.status> = [
        'approved',
        'merged',
        'blocked',
        'cancelled',
        'failed',
        'no_review',
      ];
      if (TERMINAL.includes(chat.status)) {
        subscriber(
          `data: ${JSON.stringify({
            chatId,
            type: 'chat_done',
            payload: {
              status: chat.status === 'approved' ? 'completed' : chat.status,
              verdict: chat.status === 'approved' ? 'approved' : chat.status,
              ...(chat.pr_url ? { prUrl: chat.pr_url } : {}),
              ...(chat.ship_error ? { shipError: chat.ship_error } : {}),
              replay: true,
            },
            ts: chat.finished_at ?? Date.now(),
          })}\n\n`,
        );
        reply.raw.end();
        return;
      }

      // Either attach to an in-flight runner or fire a fresh one. The
      // singleton invariant — exactly one runChat per chatId at any time —
      // is what fixes the load-spike bug. Every other SSE just subscribes.
      const existing = activeRuns.get(chatId);
      if (existing) {
        existing.subscribers.add(subscriber);
        request.raw.on('close', () => {
          existing.subscribers.delete(subscriber);
        });
        // Wait for the run to finish or this connection to drop. Either way,
        // we're done with this SSE response.
        try {
          await existing.promise;
        } catch {
          /* run failed — still close cleanly */
        }
        reply.raw.end();
        return;
      }

      // No active run — fire one and register. The persistence + status
      // update are now part of the multiplexed onEvent so they happen exactly
      // once even when multiple SSEs subscribe.
      const run = runWithMultiplex({
        chatId,
        template,
        chat,
      });
      run.subscribers.add(subscriber);
      request.raw.on('close', () => {
        run.subscribers.delete(subscriber);
      });
      try {
        await run.promise;
      } catch {
        /* run failed — error event already broadcast via onEvent */
      }
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

  // Save / update template. Preserves source='builtin' on existing builtin
  // rows so the daemon can still refresh them from disk on next boot. New
  // rows are always source='user'. Use POST /templates/:id/clone to fork a
  // builtin into a user-owned copy.
  fastify.post<{
    Body: { id: string; yaml: string };
    Reply: ApiResponse<object>;
  }>('/templates', async (request) => {
    try {
      const { id, yaml: yamlContent } = request.body;

      if (!id || !yamlContent) {
        return errorResponse('validation', 'id and yaml are required');
      }

      // Validate YAML before write so we don't poison the row.
      try {
        yaml.parse(yamlContent);
      } catch (parseError) {
        return errorResponse('validation', `Invalid YAML: ${parseError}`);
      }

      const existing = templates.getById(id);
      const source: 'builtin' | 'user' = existing?.source === 'builtin' ? 'builtin' : 'user';
      const template = templates.create(id, yamlContent, source);

      return successResponse(template);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── Personas ──────────────────────────────────────────────────────────

  fastify.get<{ Reply: ApiResponse<object[]> }>('/personas', async () => {
    try {
      const { listPersonas } = await import('../lib/personas.js');
      return successResponse(listPersonas());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/personas/:id', async (request) => {
    try {
      const { getPersona } = await import('../lib/personas.js');
      const row = getPersona(request.params.id);
      if (!row) {
        return errorResponse('not_found', `Persona ${request.params.id} not found`);
      }
      return successResponse(row);
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

  fastify.get<{ Reply: ApiResponse<object[]> }>('/onboard/detect-clis', async () => {
    try {
      const { detectAllClis } = await import('../lib/cli-detect.js');
      return successResponse(detectAllClis());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.post<{
    Body: { id: string; path: string };
    Reply: ApiResponse<object>;
  }>('/onboard/validate-cli-path', async (req) => {
    try {
      const { id, path: customPath } = req.body || {};
      if (!id || typeof customPath !== 'string') {
        return errorResponse('bad_request', 'id and path are required');
      }
      const { validateCliPath } = await import('../lib/cli-detect.js');
      return successResponse(validateCliPath(id as never, customPath));
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
      console.log(`[daemon] seeded template: ${id}`);
      continue;
    }

    // Mirror the persona seed loop: re-sync builtin rows from disk on every
    // boot. User-cloned rows (source='user') are NEVER overwritten — those
    // belong to the user and will be edited via /templates POST. This keeps
    // YAML source-of-truth aligned with the DB after a chorus upgrade.
    if (existing.source === 'builtin' && existing.yaml !== yamlContent) {
      templates.create(id, yamlContent, 'builtin');
      console.log(`[daemon] refreshed builtin template from disk: ${id}`);
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
