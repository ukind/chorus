import { z } from 'zod';
import { getDb } from './connection.js';

const VoiceRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.enum(['cli', 'api']),
  provider: z.string(),
  model_id: z.string(),
  lineage: z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot']),
  vendor_family: z.string().nullable(),
  input_cost_per_mtok: z.number().nullable(),
  output_cost_per_mtok: z.number().nullable(),
  enabled: z.coerce.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export type VoiceRow = z.infer<typeof VoiceRowSchema>;

export interface VoiceUpsertInput {
  id: string;
  label: string;
  source: 'cli' | 'api';
  provider: string;
  model_id: string;
  lineage: 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot';
  vendor_family?: string | null;
  input_cost_per_mtok?: number | null;
  output_cost_per_mtok?: number | null;
  enabled?: boolean;
}

export interface VoiceUpdateInput {
  label?: string;
  enabled?: boolean;
  input_cost_per_mtok?: number | null;
  output_cost_per_mtok?: number | null;
  /** Used by seed loops to rewrite the latest model on a stable-ID voice. */
  model_id?: string;
}

export interface VoiceListFilter {
  lineage?: string;
  source?: 'cli' | 'api';
  provider?: string;
  /** When `undefined`, returns all voices (enabled + disabled). */
  enabled?: boolean;
}

export const voices = {
  /**
   * Upsert a voice row. If the row exists, updates label/model_id/cost/
   * vendor_family while preserving created_at and the existing enabled
   * value (so seed loops don't trample user toggles). If new, inserts
   * with `enabled` defaulting to true.
   */
  async upsert(input: VoiceUpsertInput): Promise<VoiceRow> {
    const db = await getDb();
    const now = Date.now();
    const existing = await voices.getById(input.id);

    await db.execute({
      sql: `
        INSERT OR REPLACE INTO voices
          (id, label, source, provider, model_id, lineage, vendor_family,
           input_cost_per_mtok, output_cost_per_mtok, enabled,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        input.id,
        input.label,
        input.source,
        input.provider,
        input.model_id,
        input.lineage,
        input.vendor_family ?? null,
        input.input_cost_per_mtok ?? null,
        input.output_cost_per_mtok ?? null,
        existing?.enabled !== undefined
          ? existing.enabled
            ? 1
            : 0
          : input.enabled === false
            ? 0
            : 1,
        existing?.created_at ?? now,
        now,
      ],
    });

    const row = await voices.getById(input.id);
    if (!row) throw new Error(`voices.upsert: row vanished: ${input.id}`);
    return row;
  },

  async list(filter?: VoiceListFilter): Promise<VoiceRow[]> {
    const db = await getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.lineage) {
      where.push('lineage = ?');
      args.push(filter.lineage);
    }
    if (filter?.source) {
      where.push('source = ?');
      args.push(filter.source);
    }
    if (filter?.provider) {
      where.push('provider = ?');
      args.push(filter.provider);
    }
    if (filter?.enabled !== undefined) {
      where.push('enabled = ?');
      args.push(filter.enabled ? 1 : 0);
    }
    const sql =
      'SELECT * FROM voices' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY provider ASC, label ASC';
    const result = await db.execute({ sql, args: args as never });
    return result.rows.map((row) => VoiceRowSchema.parse(row));
  },

  async getById(id: string): Promise<VoiceRow | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM voices WHERE id = ?',
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return VoiceRowSchema.parse(result.rows[0]);
  },

  async update(id: string, partial: VoiceUpdateInput): Promise<VoiceRow> {
    const db = await getDb();
    const existing = await voices.getById(id);
    if (!existing) throw new Error(`Voice ${id} not found`);

    const next = {
      label: partial.label ?? existing.label,
      enabled: partial.enabled ?? existing.enabled,
      input_cost_per_mtok:
        partial.input_cost_per_mtok !== undefined
          ? partial.input_cost_per_mtok
          : existing.input_cost_per_mtok,
      output_cost_per_mtok:
        partial.output_cost_per_mtok !== undefined
          ? partial.output_cost_per_mtok
          : existing.output_cost_per_mtok,
      model_id: partial.model_id ?? existing.model_id,
    };

    await db.execute({
      sql: `
        UPDATE voices
        SET label = ?, enabled = ?, input_cost_per_mtok = ?, output_cost_per_mtok = ?, model_id = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [
        next.label,
        next.enabled ? 1 : 0,
        next.input_cost_per_mtok,
        next.output_cost_per_mtok,
        next.model_id,
        Date.now(),
        id,
      ],
    });

    const row = await voices.getById(id);
    if (!row) throw new Error(`voices.update: row vanished: ${id}`);
    return row;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute({ sql: 'DELETE FROM voices WHERE id = ?', args: [id] });
  },
};
