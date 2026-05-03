import { z } from 'zod';
import { getDb } from './connection.js';

const SecretSchema = z.object({
  provider: z.string(),
  kind: z.enum(['api_key', 'cli_subscription']),
  value: z.string(),
  meta: z.string().nullable(),
  updated_at: z.number().int(),
});

export type Secret = z.infer<typeof SecretSchema>;

export const secrets = {
  async set(
    provider: string,
    kind: 'api_key' | 'cli_subscription',
    value: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const db = await getDb();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO secrets (provider, kind, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [provider, kind, value, meta ? JSON.stringify(meta) : null, Date.now()],
    });
  },

  async get(provider: string): Promise<Secret | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM secrets WHERE provider = ?',
      args: [provider],
    });
    if (result.rows.length === 0) return null;
    return SecretSchema.parse(result.rows[0]);
  },

  async list(): Promise<Omit<Secret, 'value'>[]> {
    const db = await getDb();
    const result = await db.execute(
      'SELECT provider, kind, meta, updated_at FROM secrets',
    );
    return result.rows.map((row) =>
      SecretSchema.omit({ value: true })
        .extend({ meta: z.string().nullable() })
        .parse(row),
    );
  },
};
