/**
 * DB seam — barrel re-exports per-table modules.
 *
 * Connection lifecycle (getDb, _resetDbForTests, resolveDbPath) lives in
 * connection.ts; each table has its own file with schema + ops.
 *
 * Rollback lever for the libsql migration: the v0.7 swap from
 * better-sqlite3 was a clean transport change. If a hot-path perf
 * regression turns up in production, the rollback is a clean revert
 * (NOT a swap to the sync `libsql` package — its API would require
 * unwinding every `await` in this layer and its callers).
 */

export {
  _resetDbForTests,
  generateUlid,
  getDb,
  resolveDbPath,
} from './connection.js';

export { chats, type ChatRow, type CreateChatInput } from './chats.js';
export { phaseEvents, type PhaseEvent } from './phase-events.js';
export { templates, type Template } from './templates.js';
export { settings, type SettingRow } from './settings.js';
export { secrets, type Secret } from './secrets.js';
export {
  personas,
  type PersonaRow,
  type PersonaUpsertInput,
} from './personas.js';
export {
  voices,
  type VoiceListFilter,
  type VoiceRow,
  type VoiceUpdateInput,
  type VoiceUpsertInput,
} from './voices.js';
