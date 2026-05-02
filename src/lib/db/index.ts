/**
 * Chorus DB seam — backed by @libsql/client (napi-rs prebuilt for every
 * platform; no node-gyp at install time). Migrated from better-sqlite3 in
 * v0.7 to fix `npm install -g` reliability on Windows + locked-down dev
 * machines (planning/libsql-migration.md).
 *
 * SQL dialect + on-disk format are unchanged — same SQLite3 file at
 * ~/.chorus/chorus.db. Existing user DBs open cleanly.
 *
 * Rollback lever: this migration was a clean, single-PR transport swap.
 * If we discover a hot-path perf regression in production, the rollback
 * is a clean revert of that PR (NOT a swap to the sync `libsql` package
 * — that package's API is sync-better-sqlite3-compatible, so switching to
 * it would require unwinding every `await` in this file and its callers).
 */

import { createClient, type Client } from '@libsql/client';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { readFileSync } from 'fs';

let dbInstance: Client | null = null;
let dbInitPromise: Promise<Client> | null = null;

/**
 * Resolve DB path lazily inside getDb() rather than at module load. Two
 * reasons:
 *   1. CHORUS_DB_PATH env override only takes effect if read at init time.
 *      A module-level `const dbPath = ...` evaluates once on import and is
 *      then frozen, so tests setting the env after import would have no
 *      effect.
 *   2. Tests need to swap DBs between cases without restarting the
 *      process — see `_resetDbForTests()`.
 */
function resolveDbPath(): string {
  const override = process.env.CHORUS_DB_PATH;
  if (override) return override;
  return path.join(os.homedir(), '.chorus', 'chorus.db');
}

function resolveSchemaPath(): string {
  // dist/lib/db/index.js needs ../db/schema.sql; src/lib/db/index.ts in
  // tsx-watch dev mode resolves the same way. build:server copies the
  // .sql alongside the compiled .js (see package.json).
  return path.join(__dirname, '..', 'db', 'schema.sql');
}

export async function getDb(): Promise<Client> {
  if (dbInstance) return dbInstance;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = initDb()
    .then((db) => {
      dbInstance = db;
      return db;
    })
    .catch((err: unknown) => {
      // CRITICAL: clear the cached promise on failure. Without this, a
      // single transient init error (corrupted DB, FS hiccup, permission
      // glitch) would lock the daemon forever — every subsequent getDb()
      // call would return the same rejected promise until restart. With
      // the catch, the next caller retries from scratch.
      dbInitPromise = null;
      throw err;
    });

  return dbInitPromise;
}

async function initDb(): Promise<Client> {
  const dbPath = resolveDbPath();
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const isNew = !fs.existsSync(dbPath);
  const db = createClient({ url: `file:${dbPath}` });

  // libsql defaults to WAL on local file URLs. Setting it explicitly keeps
  // the intent visible in code reviews; it's a no-op if already WAL.
  await db.execute('PRAGMA journal_mode = WAL');

  if (isNew) {
    const schema = readFileSync(resolveSchemaPath(), 'utf-8');
    await db.executeMultiple(schema);
  }

  // Run idempotent column-add migrations on every startup, not just for
  // existing DBs. A fresh DB created from a stale dist/schema.sql (e.g.
  // when the build script forgot to copy the latest schema) would otherwise
  // skip these and crash on first INSERT. SQLite's ADD COLUMN is safe and
  // PRAGMA table_info gates each statement.
  const cols = (await db.execute('PRAGMA table_info(chats)')).rows as unknown as { name: string }[];
  const has = (n: string): boolean => cols.some((c) => c.name === n);
  if (!has('repo_path')) await db.execute('ALTER TABLE chats ADD COLUMN repo_path TEXT');
  if (!has('pr_url')) await db.execute('ALTER TABLE chats ADD COLUMN pr_url TEXT');
  if (!has('ship_error')) await db.execute('ALTER TABLE chats ADD COLUMN ship_error TEXT');

  // Personas table — added in v0.7. Idempotent CREATE so DBs that
  // pre-date this version pick it up without a manual migration.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      one_liner TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      recommended_lineage TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      forked_from TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  return db;
}

// Chat schemas and types
const ChatRowSchema = z.object({
  id: z.string(),
  work: z.string(),
  template_id: z.string(),
  status: z.enum(['drafting', 'reviewing', 'approved', 'merged', 'blocked', 'cancelled', 'failed', 'no_review']),
  current_phase_idx: z.number().int(),
  yolo: z.coerce.boolean().default(false),
  attached_files: z.string().nullable(),
  repo_path: z.string().nullable().default(null),
  pr_url: z.string().nullable().default(null),
  ship_error: z.string().nullable().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  finished_at: z.number().int().nullable(),
});

export type ChatRow = z.infer<typeof ChatRowSchema>;

const CreateChatSchema = z.object({
  work: z.string(),
  template_id: z.string(),
  attached_files: z.string().optional(),
  /** Absolute path to user's repo for Ship phase. Optional. */
  repo_path: z.string().optional(),
});

export type CreateChatInput = z.infer<typeof CreateChatSchema>;

// Phase event schemas
const PhaseEventSchema = z.object({
  id: z.number().int(),
  chat_id: z.string(),
  phase_idx: z.number().int(),
  phase_kind: z.enum(['plan', 'spec', 'tests', 'implement', 'review', 'verify', 'divergence']),
  role: z.enum(['doer', 'reviewer']),
  agent_id: z.string().nullable(),
  state: z.enum(['drafting', 'submitted', 'reviewing', 'approved', 'revising', 'blocked']),
  output: z.string().nullable(),
  cost_usd: z.number().default(0),
  tokens_in: z.number().int().default(0),
  tokens_out: z.number().int().default(0),
  started_at: z.number().int(),
  finished_at: z.number().int().nullable(),
});

export type PhaseEvent = z.infer<typeof PhaseEventSchema>;

// Template schemas
const TemplateSchema = z.object({
  id: z.string(),
  source: z.enum(['builtin', 'user']),
  yaml: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export type Template = z.infer<typeof TemplateSchema>;

// Settings schemas
export type SettingRow = {
  key: string;
  value: string;
};

// Secrets schemas
const SecretSchema = z.object({
  provider: z.string(),
  kind: z.enum(['api_key', 'cli_subscription']),
  value: z.string(),
  meta: z.string().nullable(),
  updated_at: z.number().int(),
});

export type Secret = z.infer<typeof SecretSchema>;

// Chat operations
export const chats = {
  async create(input: CreateChatInput): Promise<ChatRow> {
    const db = await getDb();
    const validated = CreateChatSchema.parse(input);
    const ulid = generateUlid();
    const now = Date.now();

    await db.execute({
      sql: `
        INSERT INTO chats (id, work, template_id, status, current_phase_idx, yolo, attached_files, repo_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        ulid,
        validated.work,
        validated.template_id,
        'drafting',
        0,
        0,
        validated.attached_files || null,
        validated.repo_path || null,
        now,
        now,
      ],
    });

    const row = await chats.getById(ulid);
    if (!row) throw new Error(`chats.create: row vanished after insert: ${ulid}`);
    return row;
  },

  async list(opts?: { status?: string; limit?: number; offset?: number }): Promise<ChatRow[]> {
    const db = await getDb();
    let sql = 'SELECT * FROM chats';
    const args: unknown[] = [];

    if (opts?.status) {
      sql += ' WHERE status = ?';
      args.push(opts.status);
    }

    sql += ' ORDER BY updated_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      args.push(opts.limit);
    }

    if (opts?.offset) {
      sql += ' OFFSET ?';
      args.push(opts.offset);
    }

    const result = await db.execute({ sql, args: args as never });
    return result.rows.map((row) => ChatRowSchema.parse(row));
  },

  async getById(id: string): Promise<ChatRow | null> {
    const db = await getDb();
    const result = await db.execute({ sql: 'SELECT * FROM chats WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return null;
    return ChatRowSchema.parse(result.rows[0]);
  },

  async update(id: string, partial: Partial<Omit<ChatRow, 'id' | 'created_at'>>): Promise<ChatRow> {
    const db = await getDb();
    const chat = await chats.getById(id);
    if (!chat) {
      throw new Error(`Chat ${id} not found`);
    }

    const updated = {
      ...chat,
      ...partial,
      id: chat.id,
      created_at: chat.created_at,
      updated_at: Date.now(),
    };

    await db.execute({
      sql: `
        UPDATE chats
        SET work = ?, template_id = ?, status = ?, current_phase_idx = ?, yolo = ?, attached_files = ?, repo_path = ?, pr_url = ?, ship_error = ?, updated_at = ?, finished_at = ?
        WHERE id = ?
      `,
      args: [
        updated.work,
        updated.template_id,
        updated.status,
        updated.current_phase_idx,
        updated.yolo ? 1 : 0,
        updated.attached_files,
        updated.repo_path,
        updated.pr_url,
        updated.ship_error,
        updated.updated_at,
        updated.finished_at,
        id,
      ],
    });

    const row = await chats.getById(id);
    if (!row) throw new Error(`chats.update: row vanished: ${id}`);
    return row;
  },

  async cancel(id: string): Promise<ChatRow> {
    return chats.update(id, { status: 'cancelled', finished_at: Date.now() });
  },

  /**
   * Hard-delete a chat. Removes the row + cascades to phase_events.
   * Atomic via libsql transaction so a partial failure can't leave
   * orphaned phase_events. Caller is responsible for filesystem cleanup
   * (chat artifacts in ~/.chorus/chats/<id>) and for ensuring no active
   * session is running for this chat (cancel first if needed).
   */
  async delete(id: string): Promise<void> {
    const db = await getDb();
    const tx = await db.transaction('write');
    try {
      // Phase events first to avoid FK-style orphans (no actual FK, but
      // semantically the chat owns its events).
      await tx.execute({ sql: 'DELETE FROM phase_events WHERE chat_id = ?', args: [id] });
      await tx.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [id] });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  },
};

// Phase events operations
export const phaseEvents = {
  async create(event: Omit<PhaseEvent, 'id'>): Promise<PhaseEvent> {
    const db = await getDb();
    const validated = PhaseEventSchema.omit({ id: true }).parse(event);

    const result = await db.execute({
      sql: `
        INSERT INTO phase_events (chat_id, phase_idx, phase_kind, role, agent_id, state, output, cost_usd, tokens_in, tokens_out, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        validated.chat_id,
        validated.phase_idx,
        validated.phase_kind,
        validated.role,
        validated.agent_id,
        validated.state,
        validated.output,
        validated.cost_usd,
        validated.tokens_in,
        validated.tokens_out,
        validated.started_at,
        validated.finished_at,
      ],
    });

    // libsql returns lastInsertRowid as bigint; cast to number for the
    // existing API. chorus row counts stay well under 2^53 — the cast is
    // safe and the existing PhaseEvent type uses number.
    const id = Number(result.lastInsertRowid);
    const row = await phaseEvents.getById(id);
    if (!row) throw new Error(`phaseEvents.create: row vanished: ${id}`);
    return row;
  },

  async list(chatId: string): Promise<PhaseEvent[]> {
    const db = await getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM phase_events WHERE chat_id = ? ORDER BY phase_idx, id',
      args: [chatId],
    });
    return result.rows.map((row) => PhaseEventSchema.parse(row));
  },

  async getById(id: number): Promise<PhaseEvent | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM phase_events WHERE id = ?',
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return PhaseEventSchema.parse(result.rows[0]);
  },

  async update(id: number, partial: Partial<Omit<PhaseEvent, 'id' | 'started_at'>>): Promise<PhaseEvent> {
    const db = await getDb();
    const event = await phaseEvents.getById(id);
    if (!event) {
      throw new Error(`Phase event ${id} not found`);
    }

    const updated = { ...event, ...partial };

    await db.execute({
      sql: `
        UPDATE phase_events
        SET chat_id = ?, phase_idx = ?, phase_kind = ?, role = ?, agent_id = ?, state = ?, output = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
        WHERE id = ?
      `,
      args: [
        updated.chat_id,
        updated.phase_idx,
        updated.phase_kind,
        updated.role,
        updated.agent_id,
        updated.state,
        updated.output,
        updated.cost_usd,
        updated.tokens_in,
        updated.tokens_out,
        updated.finished_at,
        id,
      ],
    });

    const row = await phaseEvents.getById(id);
    if (!row) throw new Error(`phaseEvents.update: row vanished: ${id}`);
    return row;
  },
};

// Templates operations
export const templates = {
  async create(id: string, yaml: string, source: 'builtin' | 'user' = 'user'): Promise<Template> {
    const db = await getDb();
    const now = Date.now();

    await db.execute({
      sql: `
        INSERT OR REPLACE INTO templates (id, source, yaml, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [id, source, yaml, now, now],
    });

    const row = await templates.getById(id);
    if (!row) throw new Error(`templates.create: row vanished: ${id}`);
    return row;
  },

  async list(): Promise<Template[]> {
    const db = await getDb();
    const result = await db.execute('SELECT * FROM templates ORDER BY created_at DESC');
    return result.rows.map((row) => TemplateSchema.parse(coerceTemplateYaml(row)));
  },

  async getById(id: string): Promise<Template | null> {
    const db = await getDb();
    const result = await db.execute({ sql: 'SELECT * FROM templates WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return null;
    return TemplateSchema.parse(coerceTemplateYaml(result.rows[0]));
  },
};

// SQLite stores text columns as TEXT, but `INSERT ... readfile(...)` and some
// admin tools write BLOBs.
//
// Transport-specific note (verified empirically during plan review):
//   - better-sqlite3 surfaces BLOBs as Node Buffer (extends Uint8Array).
//   - @libsql/client surfaces BLOBs as ArrayBuffer (NOT instanceof Uint8Array).
// Check ArrayBuffer first; fall through to Uint8Array as a defensive belt
// in case a Buffer-typed value sneaks in via direct stmt.run paths or
// future migrations.
function coerceTemplateYaml(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  if (r.yaml instanceof ArrayBuffer) {
    return { ...r, yaml: new TextDecoder().decode(new Uint8Array(r.yaml)) };
  }
  if (r.yaml instanceof Uint8Array) {
    return { ...r, yaml: new TextDecoder().decode(r.yaml) };
  }
  return r;
}

// Settings operations
export const settings = {
  async get(key: string): Promise<unknown | null> {
    const db = await getDb();
    const result = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
    if (result.rows.length === 0) return null;
    const value = result.rows[0].value as string;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },

  async set(key: string, value: unknown): Promise<void> {
    const db = await getDb();
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    await db.execute({
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      args: [key, stringValue],
    });
  },

  async getAll(): Promise<Record<string, unknown>> {
    const db = await getDb();
    const result = await db.execute('SELECT key, value FROM settings');
    const out: Record<string, unknown> = {};
    for (const row of result.rows) {
      const k = row.key as string;
      const v = row.value as string;
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    }
    return out;
  },
};

// Secrets operations
export const secrets = {
  async set(provider: string, kind: 'api_key' | 'cli_subscription', value: string, meta?: Record<string, unknown>): Promise<void> {
    const db = await getDb();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO secrets (provider, kind, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [provider, kind, value, meta ? JSON.stringify(meta) : null, Date.now()],
    });
  },

  async get(provider: string): Promise<Secret | null> {
    const db = await getDb();
    const result = await db.execute({ sql: 'SELECT * FROM secrets WHERE provider = ?', args: [provider] });
    if (result.rows.length === 0) return null;
    return SecretSchema.parse(result.rows[0]);
  },

  async list(): Promise<Omit<Secret, 'value'>[]> {
    const db = await getDb();
    const result = await db.execute('SELECT provider, kind, meta, updated_at FROM secrets');
    return result.rows.map((row) =>
      SecretSchema.omit({ value: true })
        .extend({ meta: z.string().nullable() })
        .parse(row),
    );
  },
};

// Persona schemas + ops
const PersonaRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  one_liner: z.string(),
  system_prompt: z.string(),
  recommended_lineage: z.string().nullable(),
  builtin: z.coerce.boolean(),
  forked_from: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export type PersonaRow = z.infer<typeof PersonaRowSchema>;

export interface PersonaUpsertInput {
  id: string;
  label: string;
  one_liner: string;
  system_prompt: string;
  recommended_lineage?: string | null;
  builtin?: boolean;
  forked_from?: string | null;
}

export const personas = {
  async upsert(input: PersonaUpsertInput): Promise<PersonaRow> {
    const db = await getDb();
    const now = Date.now();
    const existing = await personas.getById(input.id);

    await db.execute({
      sql: `
        INSERT OR REPLACE INTO personas
          (id, label, one_liner, system_prompt, recommended_lineage, builtin, forked_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        input.id,
        input.label,
        input.one_liner,
        input.system_prompt,
        input.recommended_lineage ?? null,
        input.builtin ? 1 : 0,
        input.forked_from ?? null,
        existing?.created_at ?? now,
        now,
      ],
    });

    const row = await personas.getById(input.id);
    if (!row) throw new Error(`personas.upsert: row vanished: ${input.id}`);
    return row;
  },

  async list(): Promise<PersonaRow[]> {
    const db = await getDb();
    const result = await db.execute('SELECT * FROM personas ORDER BY label ASC');
    return result.rows.map((row) => PersonaRowSchema.parse(row));
  },

  async getById(id: string): Promise<PersonaRow | null> {
    const db = await getDb();
    const result = await db.execute({ sql: 'SELECT * FROM personas WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return null;
    return PersonaRowSchema.parse(result.rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute({ sql: 'DELETE FROM personas WHERE id = ?', args: [id] });
  },
};

/**
 * @internal — for tests only. Closes the singleton handle and clears the
 * cached instance so the next `getDb()` call re-initializes against the
 * current `CHORUS_DB_PATH` env. Without this, vitest tests running in the
 * same module instance would all share the first DB they opened.
 */
export async function _resetDbForTests(): Promise<void> {
  if (dbInstance) {
    try { dbInstance.close(); } catch { /* best-effort */ }
  }
  dbInstance = null;
  dbInitPromise = null;
}

// Utility: Generate ULID
function generateUlid(): string {
  const now = Date.now();
  const randomBytes = crypto.getRandomValues(new Uint8Array(10));

  const timeBytes = now.toString(16).padStart(12, '0');
  const randBytes = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  return (timeBytes + randBytes).toUpperCase();
}
