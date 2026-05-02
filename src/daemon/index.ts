import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { chats, phaseEvents, templates } from '../lib/db';
import { TmuxManagerImpl } from './tmux.js';
import { startReaper } from './reaper.js';
import { runChat } from './runner.js';
import { ErrorDetector } from './error-detector.js';
import { TemplateSchema, isReviewOnlyPhase, templateRequiresArtifact } from '../lib/template-schema.js';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import {
  successResponse,
  errorResponse,
  type ApiResponse,
} from './api-response.js';
import {
  registerTemplateRoutes,
  registerPersonaRoutes,
} from './routes/templates-personas.js';
import {
  registerSettingsRoutes,
  registerSecretRoutes,
} from './routes/settings.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerVoiceRoutes } from './routes/voices.js';
import { logger, chatLogger } from '../lib/logger.js';

/**
 * Resolve daemon port from env, with hard validation. parseInt('chorus', 10)
 * silently returns NaN, which Fastify accepts as "let the OS pick a port" —
 * the daemon would start, bind to a random port, and the cockpit would never
 * find it. Catch this at boot with a useful error message instead.
 */
function resolveDaemonPort(): number {
  const raw = process.env.CHORUS_DAEMON_PORT;
  if (!raw) return 7707;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `CHORUS_DAEMON_PORT must be an integer between 1 and 65535. Got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

const PORT = resolveDaemonPort();
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

// Permissive chatId validator — the runner uses ULIDs (26-char Base32) but we
// keep older fixtures and the MCP create_chat surface in mind, so allow any
// short alphanumeric/dash string. Belt-and-braces against unbounded user
// input becoming a filesystem path or log file name (DoS via 100MB id).
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidChatId(value: unknown): value is string {
  return typeof value === 'string' && CHAT_ID_RE.test(value);
}

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
interface Subscriber {
  write: (line: string) => boolean; // returns true if buffer available, false if full
  paused: boolean;
  queue: string[];
  close: () => void;
}

type SubscriberFn = (eventJson: string) => void;

interface ActiveRun {
  promise: Promise<void>;
  subscribers: Set<Subscriber>;
  abortController: AbortController;
}

// Singleton runner registry — one runChat per chatId, ever. SSE re-attachers
// (browser refresh, tab open, polling, MCP wait_for_chat) all subscribe to
// the same in-memory event bus instead of re-firing the runner. Without this,
// every refresh of the run page used to spawn a fresh doer + 2 reviewers,
// hammering the LLM CLIs and thrashing system memory. See ROADMAP #17.
const activeRuns = new Map<string, ActiveRun>();

// Parsed-template cache. Every SSE attach used to re-yaml.parse + zod.parse
// the template row, which is hot when 5+ tabs are watching the same run on a
// long chat. Keyed by (templateId, updated_at) so an upsert through
// POST /templates naturally invalidates without an explicit bust call.
type ParsedTemplate = ReturnType<typeof TemplateSchema.parse>;
const templateCache = new Map<string, { stamp: number; parsed: ParsedTemplate }>();

// Soft cap so the cache can't grow unbounded under a runaway template
// upsert workload. 50 is well above the realistic working set (10 builtins +
// a handful of user clones) and trims oldest-first via Map insertion order.
const TEMPLATE_CACHE_MAX = 50;

export function getParsedTemplate(
  templateId: string,
  yamlText: string,
  stamp: number,
): ParsedTemplate {
  const hit = templateCache.get(templateId);
  if (hit && hit.stamp === stamp) return hit.parsed;
  const parsed = TemplateSchema.parse(yaml.parse(yamlText));
  templateCache.set(templateId, { stamp, parsed });
  // Evict oldest entries when we cross the cap. Map iteration order is
  // insertion order in JS, so the first key is the oldest.
  while (templateCache.size > TEMPLATE_CACHE_MAX) {
    const oldest = templateCache.keys().next().value;
    if (oldest === undefined) break;
    templateCache.delete(oldest);
  }
  return parsed;
}

// Reconstruct a RunnerEvent from a persisted phase_events row. Used to
// replay past events to a freshly-attached SSE so the run page renders
// the history without waiting for the next live event. Returns null for
// rows we can't faithfully reconstruct.
function phaseEventToRunnerEvent(
  chatId: string,
  ev: Awaited<ReturnType<typeof phaseEvents.list>>[number],
): Record<string, unknown> | null {
  const baseType =
    ev.state === 'drafting'
      ? 'phase_start'
      : ev.state === 'submitted'
        ? 'phase_done'
        : ev.state === 'blocked'
          ? 'phase_failed'
          : null;
  if (!baseType) {
    console.warn(
      `[chorus] phase event replay: unmapped state "${ev.state}" for chat ${chatId}`,
    );
    return null;
  }
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
  chat: NonNullable<Awaited<ReturnType<typeof chats.getById>>>;
}

function runWithMultiplex(args: RunWithMultiplexArgs): ActiveRun {
  const { chatId, template, chat } = args;

  // Explicit cancellation goes through POST /chats/:id/cancel which calls
  // entry.abortController.abort(). Closing an SSE does NOT abort.
  const abortController = new AbortController();
  const subscribers = new Set<Subscriber>();

  // Pending DB writes from onEvent. Fire-and-forget here would race against
  // the activeRuns.delete in `.finally()` below — a reattaching SSE could
  // see activeRuns empty (slot released) but read the stale chats row
  // (status='reviewing') and start a duplicate run. Drain this set before
  // releasing the slot. Identified during PR #1 multi-LLM review.
  const pendingWrites = new Set<Promise<unknown>>();
  const trackWrite = <T,>(p: Promise<T>): Promise<T> => {
    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
    return p;
  };

  // Single onEvent for the runChat. Persists side effects exactly once and
  // fans out to every subscribed SSE. Handles backpressure by queuing writes
  // when the kernel buffer is full. Drops subscribers that exceed queue cap.
  const onEvent: Parameters<typeof runChat>[0]['onEvent'] = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    const toRemove: Subscriber[] = [];
    for (const sub of Array.from(subscribers)) {
      try {
        if (sub.paused) {
          // Subscriber is paused due to backpressure; queue the write
          sub.queue.push(line);
          if (sub.queue.length > 1000) {
            // Queue cap exceeded; drop subscriber to prevent unbounded memory
            toRemove.push(sub);
            sub.close();
          }
        } else {
          // Try to write; check return value for backpressure
          const canContinue = sub.write(line);
          if (!canContinue) {
            // Buffer full; pause and set up drain listener
            sub.paused = true;
            // Drain listener will be set up by the SSE handler once we have the raw socket
          }
        }
      } catch {
        /* dead subscriber — remove it */
        toRemove.push(sub);
      }
    }
    // Remove dead subscribers
    for (const sub of toRemove) {
      subscribers.delete(sub);
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
      const validKinds = ['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence', 'review_only'];
      const phaseKind = validKinds.includes(kind)
        ? (kind as 'plan' | 'spec' | 'tests' | 'implement' | 'review' | 'verify' | 'divergence' | 'review_only')
        : 'plan';
      // Fire-and-forget the DB write. onEvent is typed `(e) => void` and is
      // called synchronously from the runner — awaiting here would block the
      // entire fan-out chain. SQLite serializes writes via WAL anyway.
      // Tracked in pendingWrites so the .finally drain can ensure all DB
      // state is consistent before activeRuns.delete fires.
      void trackWrite(
        phaseEvents
          .create({
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
          })
          .catch((err: unknown) => {
            chatLogger(chatId).error(
              { err: err instanceof Error ? err.message : String(err) },
              'phaseEvents.create failed',
            );
          }),
      );
    }

    // Persist per-CLI failure events (cli_error / cli_warning) to
    // phase_events so the cockpit can surface "this reviewer failed
    // with <reason>" on the per-card UI AND so post-mortem inspection
    // (sqlite, /chats/:id) shows the failure even after chat-done has
    // fired. Without this, transient subprocess crashes (opencode lock
    // contention, codex quota, gemini rate-limit-with-empty-stdout)
    // wrote 0-byte answer.md files and disappeared from the DB —
    // exactly the silent-failure bug the user hit on the PR #10 review
    // chat where opencode-cli-2 never showed why it died. Generic at
    // this layer means every shim benefits without per-CLI parser
    // changes; spawnHeadless already emits cli_failed on non-zero
    // exit and the per-shim parser detection (codex's quota_exhausted,
    // future opencode contention detection) builds on top.
    if (event.type === 'cli_error' || event.type === 'cli_warning') {
      const payload = event.payload as Record<string, unknown>;
      const kind = payload.phaseKind as string | undefined;
      const validKinds = ['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence', 'review_only'];
      const phaseKind = (kind && validKinds.includes(kind))
        ? (kind as 'plan' | 'spec' | 'tests' | 'implement' | 'review' | 'verify' | 'divergence' | 'review_only')
        : 'review';
      const errorObj = (payload.error as Record<string, unknown> | undefined) ?? {};
      const message =
        (errorObj.message as string | undefined) ??
        (payload.message as string | undefined) ??
        'unknown error';
      const errorKind = (errorObj.kind as string | undefined) ?? 'cli_error';
      void trackWrite(
        phaseEvents
          .create({
            chat_id: chatId,
            phase_idx: (payload.phaseIdx as number) ?? 0,
            phase_kind: phaseKind,
            role: (payload.role as 'doer' | 'reviewer') ?? 'reviewer',
            agent_id: (payload.agent as string) ?? null,
            state: 'errored',
            // Pack the error context into output so the cockpit's
            // existing event-list rendering (which already shows
            // `output`) surfaces the message without a schema change.
            output: `[${errorKind}] ${message}`,
            cost_usd: 0,
            tokens_in: 0,
            tokens_out: 0,
            started_at: event.ts,
            finished_at: event.ts,
          })
          .catch((err: unknown) => {
            chatLogger(chatId).error(
              { err: err instanceof Error ? err.message : String(err) },
              'phaseEvents.create (cli_error) failed',
            );
          }),
      );
    }

    // Update chats.status on terminal event. Same translation as before:
    // runner emits status='completed' for the happy path; we map to
    // 'approved' to fit the chats.status enum. Tracked so .finally drains
    // before releasing the activeRuns slot — otherwise a reattaching SSE
    // could see no active run + stale 'reviewing' status and start a dup run.
    if (event.type === 'chat_done') {
      const payload = event.payload as Record<string, unknown>;
      const status = (payload.status as string) ?? 'completed';
      // verdict is the reviewer-level outcome (separate from system-level
      // status). Always persist when present so review-only chats with
      // verdict='request_changes' are distinguishable in list views from
      // standard chats whose status='approved' implicitly means
      // verdict='approved'. Cap defensively at 32 chars — verdicts are
      // enum-shaped strings; anything longer is bogus.
      const rawVerdict = payload.verdict;
      const verdict =
        typeof rawVerdict === 'string' && rawVerdict.length > 0 && rawVerdict.length <= 32
          ? rawVerdict
          : null;
      void trackWrite(
        chats
          .update(chatId, {
            status: (status === 'completed' ? 'approved' : status) as
              | 'drafting'
              | 'reviewing'
              | 'approved'
              | 'merged'
              | 'blocked'
              | 'cancelled'
              | 'failed'
              | 'no_review',
            ...(verdict !== null ? { verdict } : {}),
            ...(typeof payload.prUrl === 'string' && payload.prUrl.length > 0
              ? { pr_url: payload.prUrl }
              : {}),
            ...(typeof payload.shipError === 'string' && payload.shipError.length > 0
              ? { ship_error: payload.shipError }
              : {}),
            finished_at: Date.now(),
          })
          .catch((err: unknown) => {
            chatLogger(chatId).error(
              { err: err instanceof Error ? err.message : String(err) },
              'chats.update on chat_done failed',
            );
          }),
      );
    }
  };

  const promise = runChat({
    chatId,
    template,
    work: chat.work,
    artifact: chat.artifact ?? undefined,
    repoPath: chat.repo_path ?? undefined,
    attachedFiles: parseAttachedFiles(chat.attached_files),
    abortSignal: abortController.signal,
    tmuxMgr,
    errorDetector,
    onEvent,
  }).finally(async () => {
    // Drain pending DB writes BEFORE releasing the slot. Without this, the
    // chat_done chats.update can still be in flight when a reattaching SSE
    // sees activeRuns empty + reads stale chats row → starts a duplicate
    // run, burns subscription quota, writes duplicate phase events.
    // allSettled so a failed write doesn't leak unhandled rejections — the
    // individual .catch handlers above already log the failure.
    if (pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(pendingWrites));
    }
    activeRuns.delete(chatId);
  });

  const entry: ActiveRun = { promise, subscribers, abortController };
  activeRuns.set(chatId, entry);
  return entry;
}

async function main() {
  // Eager DB probe: trying to open the sqlite file at startup catches
  // permission errors, schema-migration crashes, and missing-init issues
  // *before* the first HTTP request fails opaquely. Without this, the
  // cockpit would just show "db_error" with no clue for the user.
  try {
    await chats.list({ limit: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `\n[chorus] Could not open database. Run \`chorus init\` first, ` +
        `or check permissions on ~/.chorus/chorus.db.\n  detail: ${msg}\n`,
    );
    process.exit(1);
  }

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
    const count = await seedBuiltinPersonas();
    // eslint-disable-next-line no-console
    console.log(`[daemon] seeded ${count} built-in personas`);
  } catch (err) {
    // Non-fatal: daemon still works without personas. Log for diagnostics.
    // eslint-disable-next-line no-console
    console.warn('[daemon] persona seed failed:', err instanceof Error ? err.message : err);
  }

  // Voices Phase 1 — synchronous, pre-listen seed of single-model CLIs +
  // first-boot migration from <lineage>.enabled_models. Fast (no
  // shell-outs); blocks listen on intent (we want voices ready before
  // routes serve).
  try {
    const { seedCliVoices } = await import('../lib/voices.js');
    const result = await seedCliVoices();
    // eslint-disable-next-line no-console
    console.log(
      `[daemon] voices Phase 1: +${result.added} added, ${result.updated} updated, ${result.disabled} auto-disabled`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[daemon] voices Phase 1 seed failed:', err instanceof Error ? err.message : err);
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

      const list = await chats.list({
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
      if (!isValidChatId(request.params.id)) {
        return errorResponse('validation', 'invalid chat id');
      }
      const chat = await chats.getBySlugOrId(request.params.id);

      if (!chat) {
        return errorResponse('not_found', `Chat ${request.params.id} not found`);
      }

      // phaseEvents.list keys by ULID, not slug. Use the resolved row's
      // id so a /chats/<slug> request returns events correctly.
      const events = await phaseEvents.list(chat.id);

      return successResponse({ ...chat, events });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Create chat
  fastify.post<{
    Body: { work: string; templateId: string; files?: string[]; repoPath?: string; artifact?: string };
    Reply: ApiResponse<object>;
  }>('/chats', async (request) => {
    try {
      const { work, templateId, files, repoPath, artifact } = request.body;

      if (!work || !templateId) {
        return errorResponse('validation', 'work and templateId are required');
      }

      // Validate repoPath if supplied — must be an absolute path to an
      // existing directory. Stricter checks (is-a-repo, gh-authed) happen
      // when the ship phase runs, not at chat creation time. We resolve to
      // canonical form first to neutralise `/foo/../etc/passwd` traversal
      // tricks, and use path.isAbsolute so Windows paths (`C:\`, UNC) pass.
      if (repoPath !== undefined) {
        if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
          return errorResponse('validation', 'repoPath must be an absolute path');
        }
        const resolved = path.resolve(repoPath);
        const fsModule = await import('fs');
        if (!fsModule.existsSync(resolved)) {
          return errorResponse('validation', `repoPath does not exist: ${resolved}`);
        }
      }

      // Parse the template up-front so we can branch on review-only vs
      // standard. Two reads of the same template are tolerable (this path
      // is request-scoped, not hot); the alternative is hand-rolling YAML
      // parsing twice in the same handler.
      const validKinds = ['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence'] as const;
      let initialPhaseKind: typeof validKinds[number] | 'review_only' = 'plan';
      let parsedTemplateForArtifactCheck: ReturnType<typeof TemplateSchema.parse> | null = null;
      try {
        const tmpl = await templates.getById(templateId);
        if (tmpl) {
          const rawParsed = yaml.parse(tmpl.yaml);
          // Use the schema to enforce the discriminated-union shape so we
          // know at this point whether kind === 'review_only'.
          const safe = TemplateSchema.safeParse(rawParsed);
          if (safe.success) {
            parsedTemplateForArtifactCheck = safe.data;
            const firstKind = safe.data.phases[0]?.kind;
            initialPhaseKind = firstKind as typeof initialPhaseKind;
          } else {
            // Fall back to a loose read so older malformed templates still
            // produce an initial event with their declared kind.
            const loose = rawParsed as { phases?: Array<{ kind?: string }> } | undefined;
            const firstKind = loose?.phases?.[0]?.kind;
            if (firstKind === 'review_only') initialPhaseKind = 'review_only';
            else if (typeof firstKind === 'string' && (validKinds as readonly string[]).includes(firstKind)) {
              initialPhaseKind = firstKind as typeof validKinds[number];
            }
          }
        }
      } catch {
        /* fall through with 'plan' default */
      }

      // Artifact validation — only meaningful for review-only templates.
      // Required-when-template-says-so, capped by phase.artifact.maxBytes.
      if (parsedTemplateForArtifactCheck && templateRequiresArtifact(parsedTemplateForArtifactCheck)) {
        if (typeof artifact !== 'string' || artifact.trim().length === 0) {
          return errorResponse(
            'validation',
            'artifact is required for review-only templates',
          );
        }
        const firstPhase = parsedTemplateForArtifactCheck.phases[0];
        if (firstPhase && isReviewOnlyPhase(firstPhase)) {
          const maxBytes = firstPhase.artifact.maxBytes;
          const byteLen = Buffer.byteLength(artifact, 'utf-8');
          if (byteLen > maxBytes) {
            return errorResponse(
              'validation',
              `artifact exceeds template limit (${byteLen} bytes > ${maxBytes} bytes)`,
            );
          }
        }
      } else if (artifact !== undefined && artifact !== null && artifact !== '') {
        // Non-review-only templates: artifact is meaningless. Reject loudly
        // so callers don't silently lose payload (e.g. mistyped templateId
        // pointing at a full-pipeline template).
        return errorResponse(
          'validation',
          'artifact is only valid for review-only templates',
        );
      }

      const chat = await chats.create({
        work,
        template_id: templateId,
        attached_files: files ? JSON.stringify(files) : undefined,
        repo_path: repoPath,
        artifact: artifact ?? undefined,
      });

      // Note: tmux sessions are created on-demand via tmuxMgr.acquire() when phases run.
      // This endpoint is for chat creation only.

      // Create initial phase event
      await phaseEvents.create({
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

      chatLogger(chat.id).info(
        {
          templateId,
          phaseKind: initialPhaseKind,
          requestId: request.id,
          hasArtifact: artifact !== undefined && artifact !== null && artifact !== '',
          hasRepoPath: repoPath !== undefined,
          attachedFileCount: files?.length ?? 0,
        },
        'chat created',
      );

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { requestId: request.id, err: message, route: 'POST /chats' },
        'chat create failed',
      );
      return errorResponse('db_error', message);
    }
  });

  // Cancel chat
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/cancel', async (request) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return errorResponse('validation', 'invalid chat id');
      }
      // Resolve slug → ULID first. Cancel/abort/tmux all key by ULID.
      const existing = await chats.getBySlugOrId(param);
      if (!existing) {
        return errorResponse('not_found', `Chat ${param} not found`);
      }
      const chatId = existing.id;
      const chat = await chats.cancel(chatId);

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

  // Re-run an existing chat. Creates a fresh chat row carrying over the
  // same work + template_id + attached_files + repo_path + artifact, plus
  // an initial phase event mirroring /chats POST. Intended for the
  // cancelled/failed → Retry button on the run viewer; the original chat
  // row stays untouched as history. Returns the new chat row so the
  // caller can navigate by slug.
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/rerun', async (request) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return errorResponse('validation', 'invalid chat id');
      }
      const original = await chats.getBySlugOrId(param);
      if (!original) {
        return errorResponse('not_found', `Chat ${param} not found`);
      }
      const newChat = await chats.create({
        work: original.work,
        template_id: original.template_id,
        attached_files: original.attached_files ?? undefined,
        repo_path: original.repo_path ?? undefined,
        artifact: original.artifact ?? undefined,
      });
      // Mirror the create-path's initial phase_event so the cockpit gets a
      // populated stepper from t=0.
      let initialPhaseKind:
        | 'plan' | 'spec' | 'tests' | 'implement' | 'review'
        | 'verify' | 'divergence' | 'review_only' = 'plan';
      try {
        const tmpl = await templates.getById(original.template_id);
        if (tmpl) {
          const safe = TemplateSchema.safeParse(yaml.parse(tmpl.yaml));
          if (safe.success) {
            const firstKind = safe.data.phases[0]?.kind;
            if (firstKind) initialPhaseKind = firstKind as typeof initialPhaseKind;
          }
        }
      } catch {
        /* keep default */
      }
      await phaseEvents.create({
        chat_id: newChat.id,
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
      return successResponse(newChat);
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
      if (!isValidChatId(id)) {
        return errorResponse('validation', 'invalid chat id');
      }
      const existing = await chats.getBySlugOrId(id);
      if (!existing) {
        return successResponse({ id, deleted: false, reason: 'not_found' });
      }
      // Resolve to the row's authoritative ULID — every downstream key
      // (activeRuns, tmux sessions, phase_events, chat dir on disk) uses
      // the ULID, not the slug. Without this the route partly worked
      // when called by slug but failed to abort the runner / kill tmux.
      const ulid = existing.id;

      // 1. Cancel first if still active — flips status, signals abort.
      if (
        existing.status === 'drafting' ||
        existing.status === 'reviewing'
      ) {
        try {
          await chats.cancel(ulid);
        } catch {
          /* best-effort */
        }
      }

      // 1b. Abort the in-memory runner if one is active for this chat.
      // Otherwise the runner could keep streaming events and write to a chat
      // dir that we're about to rm -rf, plus it would re-create the row.
      const active = activeRuns.get(ulid);
      if (active) {
        active.abortController.abort();
        // Wait for the runner to settle before proceeding with the delete.
        // Use a 5-second timeout to avoid hanging forever.
        try {
          await Promise.race([
            active.promise.catch(() => {}),
            new Promise(r => setTimeout(r, 5000)),
          ]);
        } catch {
          /* timeout or error — proceed with delete anyway */
        }
      }

      // 2. Kill any tmux sessions tied to this chat.
      try {
        const allSessions = tmuxMgr.list();
        for (const session of allSessions) {
          if (session.chatId === ulid) tmuxMgr.kill(session.name);
        }
      } catch {
        /* tmuxMgr may not be ready in test paths */
      }

      // 3. Drop DB row + phase events.
      await chats.delete(ulid);

      // 4. Nuke chat artifacts directory.
      const fsModule = await import('fs');
      const pathModule = await import('path');
      const osModule = await import('os');
      const chatDir = pathModule.join(osModule.homedir(), '.chorus', 'chats', ulid);
      if (fsModule.existsSync(chatDir)) {
        try {
          fsModule.rmSync(chatDir, { recursive: true, force: true });
        } catch (err) {
          // Don't fail the request — DB row is already gone, dir is just
          // disk-space cleanup.
          console.warn(`[chorus] failed to remove ${chatDir}:`, err);
        }
      }

      return successResponse({ id: ulid, deleted: true });
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
      const chatId = request.params.id;
      if (!isValidChatId(chatId)) {
        return errorResponse('validation', 'invalid chat id');
      }
      const { answer } = request.body;

      if (!answer) {
        return errorResponse('validation', 'answer is required');
      }

      const chat = await chats.update(chatId, { status: 'reviewing' });

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
    const param = request.params.id;

    if (!isValidChatId(param)) {
      reply.code(400);
      return { error: 'invalid chat id' };
    }

    try {
      const chat = await chats.getBySlugOrId(param);

      if (!chat) {
        reply.code(404);
        return { error: 'not found' };
      }
      // From here on, `chatId` is the row's authoritative ULID — every
      // downstream key (activeRuns, subscribers, runWithMultiplex) uses
      // the ULID, never the slug.
      const chatId = chat.id;

      const tmplRow = await templates.getById(chat.template_id);
      if (!tmplRow) {
        reply.code(404);
        return { error: 'template not found' };
      }

      // Parse template YAML (cached by templateId + updated_at so SSE
      // re-attaches don't re-parse on every browser refresh).
      let template;
      try {
        template = getParsedTemplate(
          tmplRow.id,
          tmplRow.yaml,
          tmplRow.updated_at,
        );
      } catch (parseError) {
        reply.code(400);
        return {
          error: `Invalid template: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }

      // Take ownership of the underlying socket. Without `reply.hijack()`
      // Fastify would auto-end the response when this async handler returns
      // (line 987 / 1004) — the SSE would close immediately after the
      // initial replay even though we still want to keep streaming live
      // events. Hijack tells Fastify "I own this socket, do not touch it
      // again." The response is closed manually in the request 'close'
      // handler below or via subscriber.close() on chat termination.
      reply.hijack();

      // Set SSE headers.
      //
      // Do NOT add Content-Encoding: gzip here, and do not stick a buffering
      // proxy in front of this route. SSE is line-delimited (`data: ...\n\n`);
      // gzip's compression window batches bytes until flush, which collapses
      // many small events into one frame and breaks the client's per-event
      // parser. CLIProxyAPI documents the same constraint with
      // `Accept-Encoding: identity` on its upstream calls — this is a known
      // proxy gotcha, not a Chorus quirk.
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Subscriber for THIS SSE connection with backpressure support.
      // Checks write() return value; pauses on full buffer and resumes on drain.
      const subscriber: Subscriber = {
        paused: false,
        queue: [],
        write: (line: string) => {
          try {
            return reply.raw.write(line);
          } catch {
            /* connection closed mid-write */
            return false;
          }
        },
        close: () => {
          reply.raw.end();
        },
      };

      // Replay past phase_events from DB so a late-attach run page sees the
      // history immediately instead of a blank screen. We synthesise the same
      // RunnerEvent shape the live stream uses (phase_start / phase_done /
      // phase_failed). This is best-effort — DB doesn't capture phase_progress
      // or cli_error, so live tail is still richer.
      const pastEvents = await phaseEvents.list(chatId);
      for (const ev of pastEvents) {
        const reconstructed = phaseEventToRunnerEvent(chatId, ev);
        if (reconstructed) {
          const line = `data: ${JSON.stringify(reconstructed)}\n\n`;
          if (!subscriber.write(line)) {
            subscriber.paused = true;
          }
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
        const line = `data: ${JSON.stringify({
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
        })}\n\n`;
        subscriber.write(line);
        reply.raw.end();
        return;
      }

      // Set up drain listener for backpressure recovery.
      //
      // CRITICAL: clear `paused` unconditionally on drain even if the queue
      // is empty. Race fix from cdx-1 round-2: a write that returns false
      // with no queued follow-up at drain time would otherwise leave the
      // subscriber permanently paused — every later event would funnel into
      // the queue (because dispatch in onEvent only queues when paused),
      // and no further drain ever fires (the kernel buffer is already
      // empty). Order: unpause first, then flush whatever queued up.
      const onDrain = () => {
        if (!subscriber.paused) return;
        subscriber.paused = false;
        while (subscriber.queue.length > 0) {
          const queuedLine = subscriber.queue.shift() as string;
          const canContinue = subscriber.write(queuedLine);
          if (!canContinue) {
            subscriber.paused = true;
            break;
          }
        }
      };
      reply.raw.on('drain', onDrain);

      // Either attach to an in-flight runner or fire a fresh one. The
      // singleton invariant — exactly one runChat per chatId at any time —
      // is what fixes the load-spike bug. Every other SSE just subscribes.
      const existing = activeRuns.get(chatId);
      if (existing) {
        existing.subscribers.add(subscriber);
        request.raw.on('close', () => {
          existing.subscribers.delete(subscriber);
          reply.raw.removeListener('drain', onDrain);
        });
        // Don't await the promise here — just set up the subscriber and return.
        // The SSE will close when the client disconnects or the run finishes.
        // The runner doesn't block on client disconnect.
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
        reply.raw.removeListener('drain', onDrain);
      });
      // Don't await the promise here — just set up the subscriber and return.
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
      }
      reply.raw.end();
    }
  });

  // Decoupled route groups — extracted into dedicated modules so this
  // file can stay focused on the chat lifecycle + runner orchestration.
  registerTemplateRoutes(fastify);
  registerPersonaRoutes(fastify);
  registerSettingsRoutes(fastify);
  registerSecretRoutes(fastify);
  registerSystemRoutes(fastify, { chorusBinPath: CHORUS_BIN_PATH });
  registerVoiceRoutes(fastify);

  // Seed built-in templates on startup
  await seedBuiltinTemplates();

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
  stopReaper = startReaper(tmuxMgr, async () => {
    // getActiveChats: return a map of chatId → status for active chats only
    // (drafting and reviewing states; terminal states are reaped)
    const allChats = await chats.list({ limit: 1000, offset: 0 });
    const activeMap = new Map<string, string>();
    const activeStatuses = new Set(['drafting', 'reviewing']);
    for (const chat of allChats) {
      if (activeStatuses.has(chat.status)) {
        activeMap.set(chat.id, chat.status);
      }
    }
    return activeMap;
  }, {
    intervalMs: 5 * 60 * 1000, // 5 min
    idleDestroyMinutes: 30,
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    // Abort all active runs with a 10-second timeout to prevent hanging
    if (activeRuns.size > 0) {
      const runs = Array.from(activeRuns.values());
      for (const entry of runs) {
        entry.abortController.abort();
      }
      try {
        await Promise.race([
          Promise.allSettled(runs.map(e => e.promise)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout waiting for active runs')), 10000)
          ),
        ]);
        console.log(`[chorus] aborted ${activeRuns.size} active runs`);
      } catch {
        console.warn('[chorus] timeout or error waiting for active runs to abort');
      }
    }
    if (stopReaper) {
      stopReaper();
    }
    await fastify.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    // Abort all active runs with a 10-second timeout to prevent hanging
    if (activeRuns.size > 0) {
      const runs = Array.from(activeRuns.values());
      for (const entry of runs) {
        entry.abortController.abort();
      }
      try {
        await Promise.race([
          Promise.allSettled(runs.map(e => e.promise)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout waiting for active runs')), 10000)
          ),
        ]);
        console.log(`[chorus] aborted ${activeRuns.size} active runs`);
      } catch {
        console.warn('[chorus] timeout or error waiting for active runs to abort');
      }
    }
    if (stopReaper) {
      stopReaper();
    }
    await fastify.close();
    process.exit(0);
  });

  await fastify.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST, version: VERSION }, 'daemon listening');
  // Keep the human-readable startup line — the install script + onboarding
  // grep for it. Structured line above is what `chorus logs` will consume.
  console.log(`Chorus daemon listening on http://${HOST}:${PORT}`);

  // Anonymous opt-out telemetry — see src/lib/telemetry.ts. First send is
  // delayed 5s so the listener is definitely up; subsequent sends every 24h.
  // All three opt-out paths (env, touch-file, settings) are honoured per send.
  const { startTelemetryHeartbeat } = await import('../lib/telemetry.js');
  const telemetryHandle = startTelemetryHeartbeat({ version: VERSION, daemonStartedAt: startTime });
  process.on('SIGTERM', () => telemetryHandle.stop());
  process.on('SIGINT', () => telemetryHandle.stop());

  // Voices Phase 2 — background warmup. `opencode models` shells out and
  // can take up to 10s; running it post-listen avoids that boot-latency
  // hit on every daemon start (per round 1 deepseek LOW). Errors are
  // logged but don't crash the daemon.
  void (async () => {
    try {
      const { seedOpencodeVoicesAsync } = await import('../lib/voices.js');
      const result = await seedOpencodeVoicesAsync();
      if (result) {
        console.log(
          `[daemon] voices Phase 2 (opencode): +${result.added} added, ${result.updated} updated, ${result.disabled} auto-disabled`,
        );
      } else {
        console.log('[daemon] voices Phase 2 (opencode): skipped (CLI not detected or shell-out failed)');
      }
    } catch (err) {
      console.warn('[daemon] voices Phase 2 failed:', err instanceof Error ? err.message : err);
    }
  })();
}

async function seedBuiltinTemplates(): Promise<void> {
  const templatesDir = path.join(__dirname, '..', '..', 'templates');

  if (!fs.existsSync(templatesDir)) {
    console.log('No templates directory found, skipping seed');
    return;
  }

  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
  const onDiskIds = new Set<string>();

  for (const file of files) {
    const id = file.replace('.yaml', '');
    onDiskIds.add(id);
    const yamlPath = path.join(templatesDir, file);
    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

    const existing = await templates.getById(id);

    if (!existing) {
      await templates.create(id, yamlContent, 'builtin');
      console.log(`[daemon] seeded template: ${id}`);
      continue;
    }

    // Mirror the persona seed loop: re-sync builtin rows from disk on every
    // boot. User-cloned rows (source='user') are NEVER overwritten — those
    // belong to the user and will be edited via /templates POST. This keeps
    // YAML source-of-truth aligned with the DB after a chorus upgrade.
    if (existing.source === 'builtin' && existing.yaml !== yamlContent) {
      await templates.create(id, yamlContent, 'builtin');
      console.log(`[daemon] refreshed builtin template from disk: ${id}`);
    }
  }

  // Delete any builtin templates that are no longer present on disk.
  // Query for all builtin templates and remove those not in onDiskIds.
  try {
    const allTemplates = await templates.list();
    let deletedCount = 0;
    for (const tmpl of allTemplates) {
      if (tmpl.source === 'builtin' && !onDiskIds.has(tmpl.id)) {
        // templates.delete is not currently exported — leave stale rows; the
        // refresh-on-disk-change above keeps content fresh, and stale rows
        // are inert (just don't appear in templatesDir). Tracked as a TODO
        // outside the libsql migration scope.
        console.log(`[daemon] would delete stale builtin template (no delete method): ${tmpl.id}`);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`[daemon] flagged ${deletedCount} stale builtin templates for cleanup`);
    }
  } catch (err) {
    // Non-fatal: if templates.list() fails, skip cleanup.
    console.warn('[daemon] failed to scan stale builtin templates:', err);
  }
}

// Auto-run main() only when this file is the process entry point. When the
// daemon module is imported from a test (e.g. tests/template-cache.test.ts
// importing the exported getParsedTemplate), we don't want a side-effecty
// fastify boot or DB probe firing on module load.
const isEntryPoint =
  typeof require !== 'undefined' && require.main === module;

if (isEntryPoint) {
  main().catch((error) => {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  });
}

/**
 * Export the tmux manager for use by other daemon modules (runner, agents, etc.)
 */
export function getTmuxManager(): TmuxManagerImpl {
  if (!tmuxMgr) {
    throw new Error('TmuxManager not initialized. Daemon may not have started yet.');
  }
  return tmuxMgr;
}
