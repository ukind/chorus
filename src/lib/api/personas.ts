import { fetchFromDaemon } from "./client";

/**
 * Daemon stores personas with snake_case columns; the UI contract here is the
 * same shape but keeps snake_case to avoid double-translation since several
 * consumers hand off the row to MCP tools that also speak snake_case. The
 * `fromRow` boundary still exists so the daemon can change shape (e.g. add
 * `tags`, `version`) without breaking callers.
 */
export interface RawPersonaRow {
  id: string;
  label: string;
  one_liner: string;
  system_prompt?: string;
  recommended_lineage?: string;
  builtin: 0 | 1 | boolean;
  forked_from?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Persona {
  id: string;
  label: string;
  one_liner: string;
  system_prompt?: string;
  recommended_lineage?: string;
  builtin: boolean;
  forked_from?: string | null;
  created_at: number;
  updated_at: number;
}

function fromRow(row: RawPersonaRow): Persona {
  return {
    id: row.id,
    label: row.label,
    one_liner: row.one_liner,
    system_prompt: row.system_prompt,
    recommended_lineage: row.recommended_lineage,
    builtin: Boolean(row.builtin),
    forked_from: row.forked_from ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** List all personas — used for the sidebar Personas page. */
export async function listPersonas(): Promise<Persona[]> {
  const rows = await fetchFromDaemon<RawPersonaRow[]>("/personas");
  return rows.map(fromRow);
}

/** Fetch a single persona including its full system_prompt. */
export async function getPersona(id: string): Promise<Persona> {
  const row = await fetchFromDaemon<RawPersonaRow>(
    `/personas/${encodeURIComponent(id)}`,
  );
  return fromRow(row);
}
