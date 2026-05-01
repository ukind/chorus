import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { z } from 'zod';
import { readFileSync } from 'fs';

const dbDir = path.join(os.homedir(), '.chorus');
const dbPath = path.join(dbDir, 'chorus.db');

// Ensure db dir exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    const isNew = !fs.existsSync(dbPath);
    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL');

    if (isNew) {
      const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
      const schema = readFileSync(schemaPath, 'utf-8');
      dbInstance.exec(schema);
    }
    // Run idempotent column-add migrations on every startup, not just for
    // existing DBs. A fresh DB created from a stale dist/schema.sql (e.g.
    // when the build script forgot to copy the latest schema) would otherwise
    // skip these and crash on first INSERT. SQLite's ADD COLUMN is safe and
    // PRAGMA table_info gates each statement.
    const cols = dbInstance.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
    const has = (n: string): boolean => cols.some((c) => c.name === n);
    if (!has('repo_path')) dbInstance.exec(`ALTER TABLE chats ADD COLUMN repo_path TEXT`);
    if (!has('pr_url')) dbInstance.exec(`ALTER TABLE chats ADD COLUMN pr_url TEXT`);
    if (!has('ship_error')) dbInstance.exec(`ALTER TABLE chats ADD COLUMN ship_error TEXT`);

    // Personas table — added in v0.7. Idempotent CREATE so DBs that
    // pre-date this version pick it up without a manual migration.
    dbInstance.exec(`
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
  }
  return dbInstance;
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
  create(input: CreateChatInput): ChatRow {
    const db = getDb();
    const validated = CreateChatSchema.parse(input);
    const ulid = generateUlid();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO chats (id, work, template_id, status, current_phase_idx, yolo, attached_files, repo_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      ulid,
      validated.work,
      validated.template_id,
      'drafting',
      0,
      0,
      validated.attached_files || null,
      validated.repo_path || null,
      now,
      now
    );

    return chats.getById(ulid)!;
  },

  list(opts?: { status?: string; limit?: number; offset?: number }): ChatRow[] {
    const db = getDb();
    let sql = 'SELECT * FROM chats';
    const params: unknown[] = [];

    if (opts?.status) {
      sql += ' WHERE status = ?';
      params.push(opts.status);
    }

    sql += ' ORDER BY updated_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    if (opts?.offset) {
      sql += ' OFFSET ?';
      params.push(opts.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as unknown[];

    return rows.map((row) => ChatRowSchema.parse(row));
  },

  getById(id: string): ChatRow | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
    const row = stmt.get(id) as unknown;

    if (!row) return null;
    return ChatRowSchema.parse(row);
  },

  update(id: string, partial: Partial<Omit<ChatRow, 'id' | 'created_at'>>): ChatRow {
    const db = getDb();
    const chat = chats.getById(id);

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

    const stmt = db.prepare(`
      UPDATE chats
      SET work = ?, template_id = ?, status = ?, current_phase_idx = ?, yolo = ?, attached_files = ?, repo_path = ?, pr_url = ?, ship_error = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `);

    stmt.run(
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
      id
    );

    return chats.getById(id)!;
  },

  cancel(id: string): ChatRow {
    return chats.update(id, { status: 'cancelled', finished_at: Date.now() });
  },

  /**
   * Hard-delete a chat. Removes the row + cascades to phase_events. Caller
   * is responsible for filesystem cleanup (chat artifacts in
   * ~/.chorus/chats/<id>) and for ensuring no active session is running for
   * this chat (cancel first if needed).
   */
  delete(id: string): void {
    const db = getDb();
    // Phase events first to avoid FK-style orphans (no actual FK, but
    // semantically the chat owns its events).
    db.prepare('DELETE FROM phase_events WHERE chat_id = ?').run(id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
  },
};

// Phase events operations
export const phaseEvents = {
  create(event: Omit<PhaseEvent, 'id'>): PhaseEvent {
    const db = getDb();
    const validated = PhaseEventSchema.omit({ id: true }).parse(event);

    const stmt = db.prepare(`
      INSERT INTO phase_events (chat_id, phase_idx, phase_kind, role, agent_id, state, output, cost_usd, tokens_in, tokens_out, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
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
      validated.finished_at
    );

    return phaseEvents.getById(result.lastInsertRowid as number)!;
  },

  list(chatId: string): PhaseEvent[] {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM phase_events WHERE chat_id = ? ORDER BY phase_idx, id');
    const rows = stmt.all(chatId) as unknown[];

    return rows.map((row) => PhaseEventSchema.parse(row));
  },

  getById(id: number): PhaseEvent | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM phase_events WHERE id = ?');
    const row = stmt.get(id) as unknown;

    if (!row) return null;
    return PhaseEventSchema.parse(row);
  },

  update(id: number, partial: Partial<Omit<PhaseEvent, 'id' | 'started_at'>>): PhaseEvent {
    const db = getDb();
    const event = phaseEvents.getById(id);

    if (!event) {
      throw new Error(`Phase event ${id} not found`);
    }

    const updated = { ...event, ...partial };

    const stmt = db.prepare(`
      UPDATE phase_events
      SET chat_id = ?, phase_idx = ?, phase_kind = ?, role = ?, agent_id = ?, state = ?, output = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
      WHERE id = ?
    `);

    stmt.run(
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
      id
    );

    return phaseEvents.getById(id)!;
  },
};

// Templates operations
export const templates = {
  create(id: string, yaml: string, source: 'builtin' | 'user' = 'user'): Template {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO templates (id, source, yaml, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, source, yaml, now, now);
    return templates.getById(id)!;
  },

  list(): Template[] {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM templates ORDER BY created_at DESC');
    const rows = stmt.all() as unknown[];

    return rows.map((row) => TemplateSchema.parse(coerceTemplateYaml(row)));
  },

  getById(id: string): Template | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM templates WHERE id = ?');
    const row = stmt.get(id) as unknown;

    if (!row) return null;
    return TemplateSchema.parse(coerceTemplateYaml(row));
  },
};

// SQLite stores text columns as TEXT, but `INSERT ... readfile(...)` and some
// admin tools write BLOBs. better-sqlite3 surfaces those as Buffer instances.
// The Zod schema requires `yaml: string`, so coerce here at the read boundary
// instead of relaxing the schema. Idempotent for already-string rows.
function coerceTemplateYaml(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  if (Buffer.isBuffer(r.yaml)) {
    return { ...r, yaml: r.yaml.toString('utf-8') };
  }
  return r;
}

// Settings operations
export const settings = {
  get(key: string): unknown | null {
    const db = getDb();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  },

  set(key: string, value: unknown): void {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    stmt.run(key, stringValue);
  },

  getAll(): Record<string, unknown> {
    const db = getDb();
    const stmt = db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as { key: string; value: string }[];

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }

    return result;
  },
};

// Secrets operations
export const secrets = {
  set(provider: string, kind: 'api_key' | 'cli_subscription', value: string, meta?: Record<string, unknown>): void {
    const db = getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO secrets (provider, kind, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)'
    );

    stmt.run(provider, kind, value, meta ? JSON.stringify(meta) : null, Date.now());
  },

  get(provider: string): Secret | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM secrets WHERE provider = ?');
    const row = stmt.get(provider) as unknown;

    if (!row) return null;
    return SecretSchema.parse(row);
  },

  list(): Omit<Secret, 'value'>[] {
    const db = getDb();
    const stmt = db.prepare('SELECT provider, kind, meta, updated_at FROM secrets');
    const rows = stmt.all() as unknown[];

    return rows.map((row) =>
      SecretSchema.omit({ value: true })
        .extend({ meta: z.string().nullable() })
        .parse(row)
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
  upsert(input: PersonaUpsertInput): PersonaRow {
    const db = getDb();
    const now = Date.now();
    const existing = personas.getById(input.id);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO personas
        (id, label, one_liner, system_prompt, recommended_lineage, builtin, forked_from, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.id,
      input.label,
      input.one_liner,
      input.system_prompt,
      input.recommended_lineage ?? null,
      input.builtin ? 1 : 0,
      input.forked_from ?? null,
      existing?.created_at ?? now,
      now,
    );

    return personas.getById(input.id)!;
  },

  list(): PersonaRow[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM personas ORDER BY label ASC').all() as unknown[];
    return rows.map((row) => PersonaRowSchema.parse(row));
  },

  getById(id: string): PersonaRow | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as unknown;
    if (!row) return null;
    return PersonaRowSchema.parse(row);
  },

  delete(id: string): void {
    const db = getDb();
    db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  },
};

// Utility: Generate ULID
function generateUlid(): string {
  const now = Date.now();
  const randomBytes = crypto.getRandomValues(new Uint8Array(10));

  const timeBytes = now.toString(16).padStart(12, '0');
  const randBytes = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  return (timeBytes + randBytes).toUpperCase();
}
